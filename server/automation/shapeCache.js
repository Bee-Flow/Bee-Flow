/**
 * Runtime tool-shape cache.
 *
 * Each time the runner executes a real (non-dry-run) integration_action,
 * we record a *shape descriptor* of the actual return value, keyed by
 * (userId, toolName). The Builder agent reads this on its next turn and
 * prefers the real shape over the hand-curated outputSchemas.js entries.
 *
 * Storage: Redis (TTL 30d) when available; in-memory LRU fallback.
 *
 * Shapes are NOT actual data — they're field-name maps with type tags.
 * This means we never persist user content (PII, email bodies, etc.) to
 * the cache, only structural keys.
 */

const { getRedis } = require('../db');
const _metrics = require('../telemetry/httpMetrics');
const log = require('../telemetry/log');
const { parseJsonText } = require('./expr');

const REDIS_PREFIX = 'automation:shape:';
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MEM_LIMIT = 500;
const _mem = new Map(); // key -> { shape, ts }

function cacheKey(userId, toolName) {
    return `${REDIS_PREFIX}${userId || 'anon'}:${toolName}`;
}

// Deep enough for real payloads (Gmail: messages[].payload.parts[].parts[].
// body.data is depth 8); the 30-keys-per-object cap keeps it compact.
const MAX_DESCRIBE_DEPTH = 12;
const MAX_KEYS_PER_OBJECT = 30;
// Elements of a list folded into its item descriptor: the first 50 and the
// last 10, so a key only later entries carry is still seen.
const LIST_HEAD = 50;
const LIST_TAIL = 10;

/**
 * Merge two descriptors into the shape both satisfy: object keys unioned,
 * list items merged, 'null' giving way to the type it stood in for, two
 * different scalar types 'mixed' (a later reader treats that as unknown).
 */
function mergeDescriptors(a, b) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (a === b) return a;
    if (a === 'null') return b;
    if (b === 'null') return a;
    if (a === '<deep>' || b === '<deep>') return '<deep>';
    if (a === 'array<empty>' && b && typeof b === 'object' && '_array' in b) return b;
    if (b === 'array<empty>' && a && typeof a === 'object' && '_array' in a) return a;
    const objA = a && typeof a === 'object';
    const objB = b && typeof b === 'object';
    if (!objA || !objB) {
        if (!objA && !objB) {
            const nums = new Set(['integer', 'number']);
            if (nums.has(a) && nums.has(b)) return 'number';
            const strs = new Set(['string', 'long-string']);
            if (strs.has(a) && strs.has(b)) return 'long-string';
        }
        return 'mixed';
    }
    if ('_array' in a && '_array' in b) {
        const la = a._length === '10+' ? 11 : a._length;
        const lb = b._length === '10+' ? 11 : b._length;
        const len = Math.max(Number(la) || 0, Number(lb) || 0);
        return { _array: mergeDescriptors(a._array, b._array), _length: len > 10 ? '10+' : len };
    }
    if ('_json' in a && '_json' in b) return { _json: mergeDescriptors(a._json, b._json) };
    if ('_array' in a || '_array' in b || '_json' in a || '_json' in b) return 'mixed';
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeDescriptors(out[k], v) : v;
    return out;
}

/**
 * Build a shape descriptor from a runtime value, recursively: keys and type
 * tags only, never content. Lists are described by the UNION of their
 * elements (not element 0: a field only message 2 carries is a real field),
 * and a string that is JSON text — an HTTP body, an AI answer — is described
 * as `{ _json: <what it encodes> }`, because the run reads paths straight
 * through it (shared/expr/path.mjs).
 */
function describeValue(value, depth = 0) {
    if (depth > MAX_DESCRIBE_DEPTH) return '<deep>';
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') {
        const parsed = value.length > 1 ? parseJsonText(value) : undefined;
        if (parsed !== undefined) return { _json: describeValue(parsed, depth + 1) };
        // No content — just type + sample length
        return value.length > 200 ? 'long-string' : 'string';
    }
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) {
        if (value.length === 0) return 'array<empty>';
        const els = value.length > LIST_HEAD + LIST_TAIL ? [...value.slice(0, LIST_HEAD), ...value.slice(-LIST_TAIL)] : value;
        let itemShape;
        for (const el of els) itemShape = mergeDescriptors(itemShape, describeValue(el, depth + 1));
        return { _array: itemShape === undefined ? 'null' : itemShape, _length: value.length > 10 ? '10+' : value.length };
    }
    if (typeof value === 'object') {
        const out = {};
        const keys = Object.keys(value).slice(0, MAX_KEYS_PER_OBJECT); // cap per object
        for (const k of keys) out[k] = describeValue(value[k], depth + 1);
        return out;
    }
    return typeof value;
}

/**
 * Record the shape of a tool's actual output. Best-effort: failures are
 * swallowed so a misbehaving cache never breaks a run.
 */
async function recordShape({ userId, toolName, output }) {
    try {
        if (!toolName || output == null) return;
        const shape = describeValue(output);
        const payload = JSON.stringify({ shape, recordedAt: Date.now() });
        const key = cacheKey(userId, toolName);
        const r = getRedis();
        if (r && r.status === 'ready') {
            await r.set(key, payload, 'EX', TTL_SECONDS);
        } else {
            // LRU-ish: drop oldest when over the cap
            if (_mem.size >= MEM_LIMIT) {
                const firstKey = _mem.keys().next().value;
                _mem.delete(firstKey);
            }
            _mem.set(key, { shape, ts: Date.now() });
        }
    } catch (e) {
        log.warn('[shapeCache] recordShape failed:', e.message);
    }
}

/**
 * Read the most recent shape for (userId, toolName). Returns the shape
 * descriptor or null if not cached.
 */
async function getShape({ userId, toolName }) {
    try {
        const key = cacheKey(userId, toolName);
        const r = getRedis();
        if (r && r.status === 'ready') {
            const raw = await r.get(key);
            if (!raw) { _metrics.recordCache('shape', false); return null; }
            try { _metrics.recordCache('shape', true); return JSON.parse(raw).shape; } catch { return null; }
        }
        const cached = _mem.get(key);
        _metrics.recordCache('shape', !!cached);
        return cached ? cached.shape : null;
    } catch {
        return null;
    }
}

/**
 * Render a shape descriptor as a one-line text hint for the AI: deep and
 * compact, in the run's path grammar (`messages[*]: { payload: { parts[*]:
 * { body: { data } } } }`), never the descriptor's own `_array`/`_length`
 * markers (builderTools/shapeTree.js renderShape).
 */
function renderShapeHint(shape) {
    if (!shape) return null;
    const { fromDescriptor, renderShape } = require('./builderTools/shapeTree');
    return renderShape(fromDescriptor(shape));
}

/**
 * The same hint straight from a value (a dry-run output): also shows the
 * entry names of a name/value list (mail headers) and JSON text's inner
 * shape. Keys and types only.
 */
function shapeHintOf(value) {
    if (value === undefined) return null;
    const { fromValue, renderShape } = require('./builderTools/shapeTree');
    return renderShape(fromValue(value));
}

module.exports = { recordShape, getShape, renderShapeHint, shapeHintOf, describeValue, mergeDescriptors };
