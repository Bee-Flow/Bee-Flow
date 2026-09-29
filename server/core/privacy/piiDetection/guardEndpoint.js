// @typecheck
/**
 * Where the PII Guard lives — endpoint + api key, resolved at request time and
 * held briefly so an admin installing the guard takes effect without a restart.
 */

const configStore = require('../../../stores/configStore');

// ── Guard service endpoint resolution ────────────────────────────────────
// Resolved at request time so an admin installing the guard from the
// dashboard takes effect immediately (no server restart). Order of
// precedence:
//   1. configStore `pii_guard_url` / `pii_guard_api_key` (admin install action)
//   2. env `PII_SERVICE_URL` / `PII_SERVICE_API_KEY` (legacy / k8s manifest)

let _endpointCache = null;
let _endpointCacheAt = 0;
const ENDPOINT_CACHE_TTL_MS = 10_000;

async function getGuardEndpoint() {
    const now = Date.now();
    if (_endpointCache && (now - _endpointCacheAt) < ENDPOINT_CACHE_TTL_MS) {
        return _endpointCache;
    }
    let url = null;
    let apiKey = '';
    try {
        url = await configStore.getConfig('pii_guard_url') || null;
        if (url) {
            apiKey = await configStore.getSecret('pii_guard_api_key') || '';
        }
    } catch (_) { /* fall through to env */ }
    if (!url) {
        url = process.env.PII_SERVICE_URL || null;
        apiKey = process.env.PII_SERVICE_API_KEY || process.env.SERVICES_API_KEY || '';
    }
    _endpointCache = { url, apiKey };
    _endpointCacheAt = now;
    return _endpointCache;
}

function invalidateGuardEndpointCache() {
    _endpointCache = null;
    _endpointCacheAt = 0;
}

module.exports = { getGuardEndpoint, invalidateGuardEndpointCache };
