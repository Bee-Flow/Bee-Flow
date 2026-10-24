// @typecheck
'use strict';
/**
 * The structure of a run payload without its values (mcpRunReads.js).
 *
 *   shapeOf / describePayload  keys, types, list lengths, counts; no leaf value appears
 *   placeholderize             the value with every leaf replaced by a typed placeholder
 *   safeKey                    an object key that looks like data is not shown
 *
 * Pure: no database, no request. The only collaborators are two lazy requires
 * of the payload-truncation helpers.
 */

const { fallback } = require('../utils/bestEffort');

const MAX_SHAPE_DEPTH = 24;
// List elements merged into one `items` shape: enough to see optional keys
// without walking a 50 000-row list twice.
const SHAPE_SAMPLE_ITEMS = 20;

/** Object keys are structure, but a key that looks like data (an address, a long token) is not shown. */
function safeKey(key) {
    const k = String(key);
    if (k.length > 64 || k.includes('@') || /\d{8,}/.test(k)) return '«key»';
    return k;
}

/** @param {any} v */
function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

const newCounts = () => ({ nodes: 0, strings: 0, numbers: 0, booleans: 0, nulls: 0, arrays: 0, objects: 0, maxDepth: 0 });

/**
 * Merge two shapes of the same position (two elements of one list). Equal types
 * stay that type; objects take the union of their keys; anything else becomes
 * `{ type: 'mixed', of: [...] }`.
 */
function mergeShapes(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.type === 'object' && b.type === 'object') {
        const keys = { ...a.keys };
        for (const [k, s] of Object.entries(b.keys || {})) keys[k] = keys[k] ? mergeShapes(keys[k], s) : s;
        return { type: 'object', keyCount: Object.keys(keys).length, keys };
    }
    if (a.type === 'array' && b.type === 'array') {
        return { type: 'array', length: Math.max(a.length, b.length), ...(a.items || b.items ? { items: mergeShapes(a.items, b.items) } : {}) };
    }
    if (a.type === b.type) return a;
    const of = [...new Set([...(a.type === 'mixed' ? a.of : [a.type]), ...(b.type === 'mixed' ? b.of : [b.type])])];
    return { type: 'mixed', of };
}

/**
 * The shape of a JSON value: types, keys, list lengths. No leaf value appears
 * in it. `counts` is filled in as the walk goes; a walk that reaches the node
 * cap stops descending and says so (`counts.cutOff`).
 *
 * @param {any} value
 * @param {{ keys: number, nodes: number }} limits  0 = unlimited
 * @param {ReturnType<typeof newCounts> & { cutOff?: boolean }} counts
 * @param {number} [depth]
 * @returns {any}
 */
function shapeOf(value, limits, counts, depth = 1) {
    counts.nodes += 1;
    if (depth > counts.maxDepth) counts.maxDepth = depth;
    if (limits.nodes > 0 && counts.nodes > limits.nodes) { counts.cutOff = true; return { type: typeOf(value), cutOff: true }; }
    if (value === null || value === undefined) { counts.nulls += 1; return { type: 'null' }; }
    if (typeof value === 'string') { counts.strings += 1; return { type: 'string' }; }
    if (typeof value === 'number') { counts.numbers += 1; return { type: 'number' }; }
    if (typeof value === 'boolean') { counts.booleans += 1; return { type: 'boolean' }; }
    if (depth >= MAX_SHAPE_DEPTH) { counts.cutOff = true; return { type: typeOf(value), cutOff: true }; }
    if (Array.isArray(value)) {
        counts.arrays += 1;
        /** @type {any} */
        let items = null;
        for (let i = 0; i < Math.min(value.length, SHAPE_SAMPLE_ITEMS); i++) {
            items = mergeShapes(items, shapeOf(value[i], limits, counts, depth + 1));
        }
        // Elements past the sample are counted, not described.
        counts.nodes += Math.max(0, value.length - SHAPE_SAMPLE_ITEMS);
        return { type: 'array', length: value.length, ...(items ? { items } : {}) };
    }
    if (typeof value === 'object') {
        counts.objects += 1;
        const names = Object.keys(value);
        const shown = limits.keys > 0 ? names.slice(0, limits.keys) : names;
        /** @type {Record<string, any>} */
        const keys = {};
        for (const k of shown) keys[safeKey(k)] = shapeOf(value[k], limits, counts, depth + 1);
        return {
            type: 'object', keyCount: names.length, keys,
            ...(shown.length < names.length ? { moreKeys: names.length - shown.length } : {}),
        };
    }
    return { type: typeof value };
}

/**
 * A step payload as `{ present, shape, counts, bytes }`. A payload the run
 * history stored as the truncation sentinel reports that (original size, and
 * whether a full copy is kept) plus the shape of the preview it carries.
 */
function describePayload(value, limits) {
    if (value === undefined || value === null) return { present: false };
    const { isTruncatedOutput, fullOutputRefOf } = require('../core/automationModel/payloadTruncation');
    const counts = newCounts();
    if (isTruncatedOutput(value)) {
        const shape = value.preview !== undefined ? shapeOf(value.preview, limits, counts) : null;
        return {
            present: true,
            truncated: true,
            originalBytes: Number(value.originalBytes) || null,
            fullCopyKept: !!fullOutputRefOf(value),
            ...(shape ? { shape, previewCut: value.previewCut || undefined } : {}),
            counts,
        };
    }
    const shape = shapeOf(value, limits, counts);
    let bytes = null;
    try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch (e) { fallback('automation/mcpRunReadShape:describePayload', e); /* [automations-mcp] payload size unknown (unserialisable): */ }
    return { present: true, shape, counts, bytes };
}

// ── Protected values ────────────────────────────────────────────────────────

// A Privacy Shield placeholder such as [person_1]: not personal data, kept as it is.
const SHIELD_TOKEN_RE = /^\[[a-z0-9_]+_\d+\]$/;
// What the run log's own credential masking writes.
const REDACTED_MARKER_RE = /^«redacted:[a-z-]+»$/;

/**
 * The value with its structure intact and every leaf replaced by a typed
 * placeholder: «string:<chars>», «number». Booleans and null are structure and
 * stay; a Privacy Shield token and a credential marker stay as they are.
 * Keys pass through safeKey. Non-mutating.
 *
 * @param {any} value
 * @returns {any}
 */
function placeholderize(value, depth = 1) {
    if (value === null || value === undefined || typeof value === 'boolean') return value ?? null;
    if (typeof value === 'number') return '«number»';
    if (typeof value === 'string') {
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- both patterns are anchored with a single character class and no nested repeats: linear
        if (SHIELD_TOKEN_RE.test(value) || REDACTED_MARKER_RE.test(value)) return value;
        return `«string:${value.length}»`;
    }
    if (depth >= MAX_SHAPE_DEPTH) return '«too deep»';
    if (Array.isArray(value)) return value.map((v) => placeholderize(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) out[safeKey(k)] = placeholderize(value[k], depth + 1);
        return out;
    }
    return '«unsupported»';
}

module.exports = { safeKey, typeOf, newCounts, mergeShapes, shapeOf, describePayload, placeholderize };
