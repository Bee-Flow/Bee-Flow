/**
 * The generic `poll_diff` event producer.
 *
 * "Call a tool that returns a list; emit when an item's declared fields change."
 * That one shape covers every integration that can be *read* but not
 * subscribed to — which is most of them, and all of MCP (this codebase's MCP
 * client speaks only listTools/callTool, and drops connections after five
 * minutes idle, so nothing can push).
 *
 * A new integration therefore needs no code here: it declares a source spec and
 * this runtime does the polling, diffing, de-duplication and cursor keeping.
 *
 * Three properties are load-bearing and easy to get wrong:
 *   - the first poll ANCHORS and emits nothing, so activating a routine does
 *     not fire once per device that already existed;
 *   - the per-pass tool cache is keyed on userId, because a cache keyed on
 *     tool+args alone would serve one user's data to another's subscription;
 *   - a hit on maxItemsPerTick keeps the OLD hash for the deferred items, so
 *     the next tick rediscovers them instead of silently skipping them.
 */
const crypto = require('crypto');
const { walkRelativePath } = require('../bind');
const log = require('../../telemetry/log');

const CURSOR_VERSION = 1;
const CURSOR_KIND = 'pd';
// The cursor lives in a TEXT column shared with opaque provider tokens. Keep it
// small enough that a wide account cannot bloat every row.
const MAX_CURSOR_BYTES = 32_768;
const ID_HASH_LEN = 12;
const CHG_HASH_LEN = 12;

const CLAMP = {
    minIntervalMs: { min: 30_000, max: 24 * 3_600_000, dflt: 300_000 },
    cacheTtlMs: { min: 0, max: 60_000, dflt: 15_000 },
    maxItemsPerTick: { min: 1, max: 200, dflt: 25 },
    maxTrackedItems: { min: 1, max: 1000, dflt: 200 },
};

const clamp = (v, c) => {
    const n = Number.isFinite(v) ? v : c.dflt;
    return Math.min(c.max, Math.max(c.min, n));
};

function h(str, len) {
    return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, len);
}

/** Stable JSON: object keys sorted, depth- and length-capped. */
function canonical(value, depth = 0) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (depth >= 8) return '"…"';
    if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`).join(',')}}`;
}

/**
 * Reduce one item to the values that constitute "a change".
 * A `{ path, keyBy, pick }` entry turns an array into a keyed map first, so a
 * provider re-ordering its data points is not a change — and so the caller can
 * name WHICH keys moved.
 */
function projectChangePaths(item, changePaths) {
    const out = {};
    for (const cp of changePaths || []) {
        const spec = typeof cp === 'string' ? { path: cp } : cp;
        const raw = walkRelativePath(spec.path, item);
        if (spec.keyBy && Array.isArray(raw)) {
            for (const row of raw) {
                const k = row?.[spec.keyBy];
                if (k == null) continue;
                out[`${spec.path}.${k}`] = spec.pick ? row?.[spec.pick] : row;
            }
        } else {
            out[spec.path] = raw;
        }
    }
    return out;
}

// Keys that plausibly identify one item, best first. Used only by auto-derived
// sources, where no declaration told us what identity means.
const ID_CANDIDATES = [
    'id', 'uuid', 'guid', 'key', 'measurement_key', 'sku', 'resourceName', 'noteId', 'messageId',
    'threadId', 'eventId', 'fileId', 'deviceId', 'transcriptId', 'number', 'slug', 'path', 'url', 'name',
];

const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/**
 * Work out what to diff when the integration never told us.
 *
 * Finds the first array of objects in the response, the most plausible identity
 * field in it, and treats every other scalar field as meaningful. Returns null
 * when the response has nothing list-shaped — the caller reports that rather
 * than silently never firing.
 */
function inferShape(result) {
    let items = null;
    let itemsPath = '';
    if (Array.isArray(result)) {
        items = result;
    } else if (result && typeof result === 'object') {
        for (const [key, value] of Object.entries(result)) {
            if (Array.isArray(value) && value.some(v => v && typeof v === 'object' && !Array.isArray(v))) {
                items = value;
                itemsPath = key;
                break;
            }
        }
    }
    if (!items) return null;
    const first = items.find(v => v && typeof v === 'object' && !Array.isArray(v));
    if (!first) return null;

    const idPath = ID_CANDIDATES.find(k => isScalar(first[k]) && first[k] !== null && first[k] !== '')
        || Object.keys(first).find(k => isScalar(first[k]));
    if (!idPath) return null;

    const changePaths = Object.keys(first).filter(k => k !== idPath && isScalar(first[k]));
    return { itemsPath, idPath, changePaths };
}

function parseCursor(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
        const c = JSON.parse(raw);
        // A cursor written by a different version or a different source kind is
        // not ours to interpret. Re-anchor rather than guess — subscriptions
        // deliberately carry their cursor across a re-sync, so a declaration
        // change can hand us someone else's format.
        if (!c || c.v !== CURSOR_VERSION || c.k !== CURSOR_KIND) return null;
        if (!Array.isArray(c.h)) return null;
        return c;
    } catch {
        return null;
    }
}

function indexCursor(cursor) {
    const map = new Map();
    for (const entry of cursor.h) {
        if (typeof entry !== 'string' || entry.length < ID_HASH_LEN + CHG_HASH_LEN) continue;
        const id12 = entry.slice(0, ID_HASH_LEN);
        map.set(id12, { chg12: entry.slice(ID_HASH_LEN, ID_HASH_LEN + CHG_HASH_LEN), vals: cursor.vals?.[id12] });
    }
    return map;
}

function buildCursor({ entries, trunc, trackValues, now }) {
    const cursor = {
        v: CURSOR_VERSION,
        k: CURSOR_KIND,
        t: now,
        h: entries.map(e => e.id12 + e.chg12),
        ...(trunc ? { trunc: true } : {}),
    };
    if (trackValues) {
        const vals = {};
        for (const e of entries) if (e.vals !== undefined) vals[e.id12] = e.vals;
        cursor.vals = vals;
    }
    let serialized = JSON.stringify(cursor);
    if (Buffer.byteLength(serialized) > MAX_CURSOR_BYTES && cursor.vals) {
        // Drop the previous values before ever dropping a hash: losing hashes
        // means re-firing for every item on the next tick.
        delete cursor.vals;
        cursor.deg = true;
        serialized = JSON.stringify(cursor);
    }
    while (Buffer.byteLength(serialized) > MAX_CURSOR_BYTES && cursor.h.length > 1) {
        cursor.h.length = Math.floor(cursor.h.length / 2);
        cursor.trunc = true;
        serialized = JSON.stringify(cursor);
    }
    return serialized;
}

function buildPayload(item, src, { before, projected, reason, itemId }) {
    const payload = {};
    for (const [target, path] of Object.entries(src.emit.map || {})) {
        payload[target] = walkRelativePath(path, item);
    }
    if (src.auto) {
        // Nobody declared this shape, so hand the whole item over and let the
        // author bind into it after one test run.
        payload.item = item;
        payload.itemId = itemId;
    }
    if (src.emit.includeChanges) {
        const previous = before?.vals;
        const changedKeys = previous
            ? Object.keys(projected).filter(k => canonical(projected[k]) !== canonical(previous[k]))
            : Object.keys(projected);
        payload.changedKeys = changedKeys;
        payload.current = projected;
        if (previous) payload.previous = previous;
        payload.changedAt = new Date().toISOString();
        payload._reason = reason;
    }
    return payload;
}

/**
 * Normalise whatever executeTool returned into plain data.
 *
 * Two shapes have to be undone: toolExecution swallows MCP failures into
 * `{ error }` instead of throwing (so a broken poll would otherwise look like
 * "no changes" forever), and MCP results arrive as a JSON string.
 */
function normaliseToolResult(raw, tool) {
    if (raw && typeof raw === 'object' && raw.error) throw new Error(String(raw.error));
    let value = (raw && typeof raw === 'object' && 'result' in raw) ? raw.result : raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { throw new Error(`${tool} returned text that is not JSON`); }
    }
    return value;
}

/** Per-pass shared state: one tool call serves every sibling subscription. */
function makePassCtx({ toolBudget = 40, executeTool = null, resolveEntitlements = null } = {}) {
    return {
        toolBudget,
        toolCache: new Map(),
        entCache: new Map(),
        executeTool,
        resolveEntitlements,
    };
}

class BudgetExhausted extends Error {}

async function callSourceTool(sub, src, passCtx) {
    const cacheKey = `${sub.userId}|${src.tool}|${canonical(src.args || {})}`;
    const hit = passCtx.toolCache.get(cacheKey);
    if (hit) {
        if (hit.inflight) return hit.inflight;
        if (Date.now() - hit.ts < clamp(src.cacheTtlMs, CLAMP.cacheTtlMs)) return hit.value;
    }
    if (passCtx.toolBudget <= 0) throw new BudgetExhausted('source poll budget exhausted for this pass');
    passCtx.toolBudget -= 1;

    const executeTool = passCtx.executeTool || require('../../core/tools/toolDispatcher').executeTool;
    const promise = (async () => {
        const raw = await executeTool(src.tool, { ...(src.args || {}) }, {
            userId: sub.userId,
            // MCP dispatch reads the caller id from userAuth only.
            userAuth: { userId: sub.userId },
            session: null,      // headless: there is no Express session on a poll
            autoSend: false,    // a trigger poll must never cause a side effect
            // One call can serve sibling subscriptions (the per-pass cache);
            // the row goes to the subscription that made it. The ledger
            // finds the org from the user.
            egress: {
                source: 'trigger_poll',
                ids: {
                    user_id: sub.userId || null,
                    automation_id: sub.automationId || null,
                    step_id: sub.triggerStepId || null,
                },
            },
        });
        return normaliseToolResult(raw, src.tool);
    })();

    passCtx.toolCache.set(cacheKey, { ts: Date.now(), value: null, inflight: promise });
    try {
        const value = await promise;
        passCtx.toolCache.set(cacheKey, { ts: Date.now(), value, inflight: null });
        return value;
    } catch (e) {
        passCtx.toolCache.delete(cacheKey);
        throw e;
    }
}

/**
 * Is the subscriber still entitled to this integration? Re-checked every poll:
 * an admin revoking an integration must stop the polling, not merely hide the
 * trigger in the builder.
 * → true | false | 'degraded'
 */
async function userHasIntegration(userId, capabilityId, passCtx) {
    if (!capabilityId) return false;
    if (passCtx.entCache.has(userId)) return evaluate(passCtx.entCache.get(userId));
    let snapshot = null;
    try {
        const resolve = passCtx.resolveEntitlements || require('../../core/entitlements/entitlements').resolveEntitlements;
        snapshot = await resolve({ userId });
    } catch (e) {
        log.warn(`[pollDiff] entitlement resolution failed for ${userId}: ${e.message}`);
        snapshot = null;
    }
    passCtx.entCache.set(userId, snapshot);
    return evaluate(snapshot);

    function evaluate(snap) {
        if (!snap || snap.degraded) return 'degraded';
        const granted = snap.effective?.integration;
        const set = granted instanceof Set ? granted : new Set(Array.isArray(granted) ? granted : []);
        return set.has(capabilityId);
    }
}

/**
 * Poll one subscription and return the events it should dispatch.
 * Returns { events, skipped } — `skipped` is a reason string when no poll ran.
 */
async function runPollDiff(sub, eventDef, passCtx, deps = {}) {
    const src = eventDef.source;
    const store = deps.automationStore || require('../../stores/automationStore');
    const now = Date.now();

    const prev = parseCursor(sub.lastCursor);
    const minInterval = clamp(src.minIntervalMs, CLAMP.minIntervalMs);
    if (prev && now - (prev.t || 0) < minInterval) return { events: [], skipped: 'interval' };

    const entitled = await userHasIntegration(sub.userId, src.requiresIntegration, passCtx);
    if (entitled !== true) {
        return { events: [], skipped: entitled === 'degraded' ? 'degraded' : 'no_capability' };
    }

    const result = await callSourceTool(sub, src, passCtx);

    // An auto-derived source has no declared shape — infer it from what the
    // tool actually returned, every poll (a provider may add fields later).
    let shape = src;
    if (src.auto) {
        const inferred = inferShape(result);
        if (!inferred) {
            throw new Error(`${src.tool}: returned nothing list-shaped to watch`);
        }
        shape = { ...src, ...inferred };
    }

    const rawItems = walkRelativePath(shape.itemsPath, result);
    if (!Array.isArray(rawItems)) {
        throw new Error(`${src.tool}: '${shape.itemsPath || '<root>'}' did not resolve to an array`);
    }

    const maxTracked = clamp(src.maxTrackedItems, CLAMP.maxTrackedItems);
    const maxPerTick = clamp(src.maxItemsPerTick, CLAMP.maxItemsPerTick);
    const trunc = rawItems.length > maxTracked;
    const items = trunc ? rawItems.slice(0, maxTracked) : rawItems;

    const prevMap = prev ? indexCursor(prev) : null;
    const entries = [];
    const emitted = [];
    const seenIds = new Set();

    for (const item of items) {
        const rawId = walkRelativePath(shape.idPath, item);
        if (rawId == null || rawId === '') continue;      // unidentifiable ⇒ cannot diff
        const id12 = h(String(rawId), ID_HASH_LEN);
        seenIds.add(id12);
        const projected = projectChangePaths(item, shape.changePaths);
        const chg12 = h(canonical(projected), CHG_HASH_LEN);
        const before = prevMap ? prevMap.get(id12) : undefined;

        const isNew = !before;
        const isChanged = !!before && before.chg12 !== chg12;
        // prev === null is the first poll: record everything, emit nothing.
        // Truncated lists suppress appear-events, otherwise a paginated feed
        // would flap items in and out on every tick.
        const fires = prev !== null
            && ((isNew && src.emitOnAppear && !trunc) || isChanged);

        if (fires && emitted.length < maxPerTick) {
            emitted.push(buildPayload(item, src, {
                before, projected, itemId: rawId, reason: isNew ? 'appeared' : 'changed',
            }));
            entries.push({ id12, chg12, vals: src.trackValues ? projected : undefined });
        } else if (fires) {
            // Over the per-tick cap: keep the OLD state so the next tick sees
            // this item as still-changed rather than dropping the event.
            entries.push({ id12, chg12: before.chg12, vals: before.vals });
        } else {
            entries.push({ id12, chg12, vals: src.trackValues ? projected : undefined });
        }
    }

    if (src.emitOnDisappear && prevMap && prev !== null && !trunc) {
        for (const [id12, before] of prevMap) {
            if (seenIds.has(id12)) continue;
            if (emitted.length >= maxPerTick) break;
            emitted.push({
                ...(before.vals || {}),
                changedKeys: [],
                changedAt: new Date().toISOString(),
                _reason: 'disappeared',
            });
        }
    }

    await store.updateSubscription(sub.id, {
        lastCursor: buildCursor({ entries, trunc, trackValues: !!src.trackValues, now }),
    });

    if (src.emit.mode === 'batch') {
        return { events: emitted.length ? [{ items: emitted, count: emitted.length }] : [], skipped: null };
    }
    return { events: emitted, skipped: null };
}

module.exports = {
    runPollDiff,
    makePassCtx,
    BudgetExhausted,
    // The identity heuristic is shared with App Studio's connector inspection
    // (appStudio/connectorSchema.js), which answers the same question — "which
    // key identifies one row of this tool's output?" — for a different consumer.
    // Exported rather than duplicated so both stay on one candidate list.
    ID_CANDIDATES,
    // exported for tests
    _internals: { parseCursor, buildCursor, projectChangePaths, canonical, normaliseToolResult, MAX_CURSOR_BYTES },
};
