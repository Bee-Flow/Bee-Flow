/**
 * The /counts cache, owned by the feature rather than by its route.
 *
 * `routes/compliance/counts.js` serves the per-org counts body from a 60 s
 * cache, and four places inside compliance/ must be able to bust it: the
 * runner (a sweep changes every score), frameworkPolicy (enabling or
 * disabling a framework changes the set), the event bus (a DSR, an incident,
 * a marking switch) and the route itself.
 *
 * The cache therefore lives here. Before, each of those pulled `invalidate`
 * off the counts ROUTE module — a feature reaching up into its own HTTP
 * layer, which layering.test.js rightly refuses. Nothing in here knows
 * about Express or a request.
 */

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5000;

const _cache = new Map(); // orgId → { at, body }

/** Drop one org's entry, or the whole cache when orgId is null/undefined. */
function invalidate(orgId) {
    if (orgId == null) _cache.clear();
    else _cache.delete(String(orgId));
}

/**
 * The cached body for an org, or null when absent or older than the TTL.
 * `now` is injectable so the route's clock override still drives the cache.
 */
function get(orgId, now = Date.now()) {
    const hit = _cache.get(String(orgId));
    if (!hit) return null;
    if (now - hit.at > CACHE_TTL_MS) { _cache.delete(String(orgId)); return null; }
    return hit.body;
}

/** Store a body. A partial body is never passed in — that is the caller's rule. */
function set(orgId, body, now = Date.now()) {
    if (_cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = _cache.keys().next().value;
        if (oldest !== undefined) _cache.delete(oldest);
    }
    _cache.set(String(orgId), { at: now, body });
}

/** Tests only. */
function clear() { _cache.clear(); }
function size() { return _cache.size; }

module.exports = { invalidate, get, set, clear, size, CACHE_TTL_MS, CACHE_MAX_ENTRIES };
