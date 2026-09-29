// @typecheck
/**
 * Where the topic classifier (classify-service) lives: endpoint + api key,
 * resolved at request time and held briefly, the same way the PII guard's
 * endpoint is (core/privacy/piiDetection/guardEndpoint.js). Order:
 *
 *   1. configStore `automation_classifier_url` / secret
 *      `automation_classifier_api_key` (an admin setting, no restart needed)
 *   2. env `CLASSIFY_SERVICE_URL` / `CLASSIFY_SERVICE_API_KEY`, falling back
 *      to the shared `SERVICES_API_KEY`
 *
 * The config store is required lazily: the automation runner loads this
 * module, and a routine without an "is about" rule must never pay for it.
 */

const ENDPOINT_CACHE_TTL_MS = 10_000;

/** @type {{ url: string|null, apiKey: string } | null} */
let _cache = null;
let _cacheAt = 0;

function _defaultStore() {
    return require('../../stores/configStore');
}

/**
 * @param {{ store?: { getConfig: (k: string) => Promise<any>, getSecret: (k: string) => Promise<any> } | null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ url: string|null, apiKey: string }>}
 */
async function getClassifierEndpoint({ store, env = process.env } = {}) {
    const now = Date.now();
    if (_cache && (now - _cacheAt) < ENDPOINT_CACHE_TTL_MS) return _cache;
    let url = null;
    let apiKey = '';
    try {
        const s = store === undefined ? _defaultStore() : store;
        if (s) {
            url = (await s.getConfig('automation_classifier_url')) || null;
            if (url) apiKey = (await s.getSecret('automation_classifier_api_key')) || '';
        }
    } catch { /* fall through to env */ }
    if (!url) {
        url = env.CLASSIFY_SERVICE_URL || null;
        apiKey = env.CLASSIFY_SERVICE_API_KEY || env.SERVICES_API_KEY || '';
    }
    _cache = { url: url ? String(url).replace(/\/+$/, '') : null, apiKey };
    _cacheAt = now;
    return _cache;
}

function invalidateClassifierEndpointCache() {
    _cache = null;
    _cacheAt = 0;
}

module.exports = { getClassifierEndpoint, invalidateClassifierEndpointCache };
