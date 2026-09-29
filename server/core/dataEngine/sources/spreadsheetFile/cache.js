/**
 * The in-process DOWNLOAD CACHE — one copy of a file's bytes, and of what was
 * parsed from them, per version marker; shared by describe, sync and (later)
 * write-through.
 *
 * Why it exists: a spreadsheet is the one source a mirror cannot ask for
 * one row of. Every look that finds the marker moved is a whole download and
 * a whole parse, and three things ask for the same download within seconds
 * of each other — the wizard describing a file, then re-describing it at
 * another header row; two mirrors of two tabs of ONE workbook pulsing in the
 * same 5 s window; a bulk import writing twenty rows into one csv. Keyed by
 * `provider | fileId | marker`, so a file that changed is never served from
 * here (its marker moved), and a file that did not is never fetched twice.
 *
 * ── BOUNDED TWICE ───────────────────────────────────────────────────
 * Sixty seconds from insertion (not from last use — a hit must not keep a
 * 20 MB workbook resident for ever) and a byte budget of ~100 MB for the
 * process, oldest out first. Parsed results hang off their bytes' entry and
 * leave with it; a cells-API read (a native Sheet, an Excel workbook through
 * Graph) has no bytes and is stored as a parsed value on an entry of its own.
 *
 * ── ONE DOWNLOAD IN FLIGHT PER KEY ──────────────────────────────────
 * Two callers asking for the same key at the same moment share one promise:
 * the second waits for the first's bytes instead of starting a second
 * download the storage would count against the linker's quota.
 *
 * Process-local on purpose — a replica caches what it read; a mirror's
 * correctness never depends on a hit (a miss is a download, never a stale
 * answer).
 *
 * ── ONE WRITER PER FILE ─────────────────────────────────────────────
 * `withLock(key, fn)` is the write-through's mutex, keyed the same way as
 * the cache (`provider | fileId`, no marker): a write is download → edit →
 * upload, and two of them on ONE file — two tabs of one workbook are two
 * mirrors, two editors on one table are two requests — would race on the
 * same etag and the loser would lose its whole rewrite to a 412. Serialised
 * here they take turns and the second one reads what the first one wrote.
 * Per process, like the cache; across replicas the storage's own If-Match
 * (or the emulated version guard) is what still decides.
 */

'use strict';

const TTL_MS = 60_000;
const BUDGET_BYTES = 100 * 1024 * 1024;
/** Rough bytes per parsed cell — what a row array of small values costs in V8. */
const CELL_ESTIMATE = 16;

const entries = new Map();   // key → { at, size, buffer, parsed: Map<subKey, { size, value }> }
const inFlight = new Map();  // key → Promise<Buffer>
let total = 0;

/** A marker as a stable string: sorted keys, so the same probe makes the same key. */
function markerKey(marker) {
    if (!marker || typeof marker !== 'object') return 'none';
    const keys = Object.keys(marker).sort();
    return JSON.stringify(keys.map(k => [k, marker[k] === undefined ? null : marker[k]]));
}

/** The cache key of one file at one version. */
function keyOf(provider, fileId, marker) {
    return `${provider}|${fileId}|${markerKey(marker)}`;
}

function drop(key) {
    const e = entries.get(key);
    if (!e) return;
    total -= e.size;
    entries.delete(key);
}

/** Expire by age, then by budget (oldest first). */
function sweep(now = Date.now()) {
    for (const [key, e] of entries) {
        if (now - e.at >= TTL_MS) drop(key);
    }
    if (total <= BUDGET_BYTES) return;
    const byAge = [...entries.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of byAge) {
        if (total <= BUDGET_BYTES) break;
        drop(key);
    }
}

function live(key, now = Date.now()) {
    const e = entries.get(key);
    if (!e) return null;
    if (now - e.at >= TTL_MS) { drop(key); return null; }
    return e;
}

function ensure(key) {
    const e = live(key);
    if (e) return e;
    const fresh = { at: Date.now(), size: 0, buffer: null, parsed: new Map() };
    entries.set(key, fresh);
    return fresh;
}

function grow(e, delta) {
    e.size += delta;
    total += delta;
}

/**
 * The bytes of a file at a version — from the cache, or from `load()` once,
 * however many callers ask while it runs.
 * @param {string} key                       keyOf(...)
 * @param {() => Promise<Buffer>} load       the download
 * @returns {Promise<Buffer>}
 */
async function bytes(key, load) {
    const hit = live(key);
    if (hit && hit.buffer) return hit.buffer;
    if (inFlight.has(key)) return inFlight.get(key);
    const p = Promise.resolve().then(load).then((buffer) => {
        if (!Buffer.isBuffer(buffer)) throw new TypeError('spreadsheetFile/cache: the loader must answer a Buffer');
        const e = ensure(key);
        if (!e.buffer) grow(e, buffer.length);
        e.buffer = buffer;
        sweep();
        return buffer;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
}

/**
 * A parsed value derived from a file at a version — a sheet read at a
 * header row, a tab list — computed once per `subKey` by `compute()`.
 * `size` is the caller's estimate of what the value weighs; a reader's
 * contract (`{ rows }`) is estimated from its cell count when none is given.
 * @returns {Promise<any>}
 */
async function parsed(key, subKey, compute, { size = null } = {}) {
    const hit = live(key);
    if (hit && hit.parsed.has(subKey)) return hit.parsed.get(subKey).value;
    const value = await compute();
    const e = ensure(key);
    if (!e.parsed.has(subKey)) {
        const weight = Number.isFinite(size) ? size : estimate(value);
        e.parsed.set(subKey, { size: weight, value });
        grow(e, weight);
        sweep();
    }
    return value;
}

function estimate(value) {
    if (!value || typeof value !== 'object') return 256;
    const rows = Array.isArray(value.rows) ? value.rows : (Array.isArray(value) ? value : null);
    if (!rows) return 1024;
    const width = Array.isArray(rows[0]) ? rows[0].length : (Array.isArray(value.header) ? value.header.length : 8);
    return 1024 + rows.length * Math.max(1, width) * CELL_ESTIMATE;
}

/** Forget one file version (a write replaced it), or one provider|fileId prefix. */
function forget(prefix) {
    for (const key of [...entries.keys()]) if (key === prefix || key.startsWith(`${prefix}|`)) drop(key);
}

function clear() {
    entries.clear();
    inFlight.clear();
    total = 0;
}

/** For tests and diagnostics. */
function stats() {
    return { entries: entries.size, bytes: total, inFlight: inFlight.size, locks: locks.size, ttlMs: TTL_MS, budgetBytes: BUDGET_BYTES };
}

// ── the per-file write lock ─────────────────────────────────────────────

const locks = new Map();     // lockKey → Promise that settles when the current holder releases

/** The lock key of one file, whatever its version: the cache key without the marker. */
function lockKeyOf(provider, fileId) {
    return `${provider}|${fileId}`;
}

/**
 * Run `fn` as the only writer of `key` in this process. Waiters queue in
 * arrival order; a holder that throws still releases. The chain never
 * rejects — a waiter waits for the release, not for the holder's outcome.
 * @template T
 * @param {string} key                 lockKeyOf(...)
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLock(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const turn = previous.then(() => mine);
    locks.set(key, turn);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (locks.get(key) === turn) locks.delete(key);
    }
}

module.exports = { keyOf, markerKey, lockKeyOf, bytes, parsed, forget, clear, sweep, stats, withLock, TTL_MS, BUDGET_BYTES };
