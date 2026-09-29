// @typecheck
/**
 * Scan cache and single-flight — the LRU every caller of detectPii() inherits,
 * the key it is addressed by, the table that joins identical in-flight scans,
 * and the per-caller clone that keeps a shared result from being mutated.
 */

const crypto = require('crypto');
const { isCustomTypeId } = require('../customTypes/ids');

// ── Cache (LRU, 5-min TTL) ───────────────────────────────────────────
// Sized up from 200 when detectPii() itself became the caching layer: it now
// serves every caller (DLP preflight, memory scrub, tool gates, attachment
// fallbacks), not just validateInput/OutputForPii. Entries are small entity
// arrays; 500 of them is a few hundred KB.
const CACHE_MAX = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

/**
 * Cache key for a scan result.
 *
 * This used to be `pii:${channel}:${text.length}:${text.slice(0, 200)}`, which
 * was a CORRECTNESS bug, not merely a weak cache:
 *
 *   1. Two different texts with the same length AND the same first 200
 *      characters shared an entry. That is not exotic — a templated prompt
 *      with a fixed header longer than 200 chars, or a regenerate where one
 *      word later in the message changed without changing the length, both
 *      collide. On a hit, validateInputForPii feeds the cached entities to
 *      tokenizeText, which splices by offset/length — so it redacted the
 *      character ranges of a DIFFERENT message, corrupting the text and
 *      leaving the real PII in place.
 *   2. It ignored `enabledCategories` and `confidenceThreshold`, so an admin
 *      changing the Privacy Shield categories or moving the confidence slider
 *      had no effect for up to 5 minutes, and a narrow scan's result could be
 *      served to a caller that asked for all categories.
 *
 * Hashing the full text removes (1); including the threshold and the sorted
 * category list removes (2).
 *
 * A list holding "Your own data" ids (cdt_…) adds a third part: the digest of
 * those types' current specs. The id stays the same when an admin adds a word
 * or fixes a pattern, and without the digest the old answer would be served
 * for the rest of the TTL. `customKey` overrides it (a scan against types
 * passed in directly, not the registry). A list without custom ids gets
 * exactly the key it always had.
 */
function cacheKey(channel, text, enabledCategories, confidenceThreshold, customKey = null) {
    const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const cats = Array.isArray(enabledCategories) && enabledCategories.length
        ? [...enabledCategories].sort().join(',')
        : 'all';
    const thr = typeof confidenceThreshold === 'number' ? confidenceThreshold.toFixed(4) : 'default';
    const key = `pii:${channel}:${thr}:${cats}:${digest}`;
    if (customKey) return `${key}:c=${customKey}`;
    if (Array.isArray(enabledCategories) && enabledCategories.some(isCustomTypeId)) {
        return `${key}:c=${require('../customTypes/registry').digestFor(enabledCategories)}`;
    }
    return key;
}

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.result;
}

function cacheSet(key, result) {
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, { result, timestamp: Date.now() });
}

// ── Single-flight ────────────────────────────────────────────────────
// Identical scans already in flight are joined instead of re-sent. This is
// the "three users retrying the same broken paste = 3x load" fix from the
// incident notes, and it also dedupes the tool-result lanes (3 concurrent)
// when a tool returns the same payload twice. Joiners of a DEGRADED result
// receive it once; the entry is deleted on settle, and degraded results are
// never cached, so the NEXT call after a failure scans again — the
// never-cache-degraded retry semantics are unchanged.
const _inflightScans = new Map();

/**
 * Per-caller copy of a shared (cached or joined) scan result.
 *
 * Callers annotate and splice the entity objects (tokenizeText, dlpRunner
 * match building). Handing every caller the same object graph would let one
 * caller's mutation corrupt the cache — the same class of bug as the
 * truncated-key cache collision documented on cacheKey().
 */
const _cloneEntity = (e) => (Array.isArray(e.alsoCategories) ? { ...e, alsoCategories: [...e.alsoCategories] } : { ...e });

function _cloneScanResult(result) {
    if (!result) return result;
    const out = {
        ...result,
        entities: (result.entities || []).map(_cloneEntity),
        degradedCategories: Array.isArray(result.degradedCategories)
            ? [...result.degradedCategories]
            : result.degradedCategories,
    };
    // A window scan with custom labels keeps the guard's custom answers apart
    // until the final merge (customTypes/scan.js).
    if (Array.isArray(result.customEntities)) out.customEntities = result.customEntities.map(_cloneEntity);
    return out;
}

module.exports = {
    cache,
    cacheKey,
    cacheGet,
    cacheSet,
    _inflightScans,
    _cloneScanResult,
};
