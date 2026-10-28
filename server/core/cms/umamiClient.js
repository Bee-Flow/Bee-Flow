// @typecheck noImplicitAny
/**
 * Umami analytics client — thin wrapper over a self-hosted Umami instance.
 *
 * Umami (https://umami.is) is the self-hosted, cookieless web-analytics engine
 * that powers the Website CMS (ProductWebsite) usage dashboard. We run it as a
 * sidecar container against the existing Postgres; this module is the ONLY place
 * the server talks to it. The frontend never holds Umami credentials — the CMS
 * admin routes proxy through here (see server/routes/cms.js).
 *
 * Config resolution mirrors the guard/search sidecar pattern (piiDetection.js):
 * configStore first, environment-variable fallback, 10s endpoint cache.
 *   - cms_analytics_url            (config)  e.g. https://stats.example.com
 *   - cms_analytics_username       (secret)  admin user for token login
 *   - cms_analytics_password       (secret)  admin password for token login
 *   - cms_analytics_api_token      (secret)  optional pre-minted token / cloud
 *                                            x-umami-api-key (skips login)
 * Env fallbacks: UMAMI_URL, UMAMI_USERNAME, UMAMI_PASSWORD, UMAMI_API_TOKEN.
 *
 * Auth: self-hosted Umami issues a Bearer JWT from POST /api/auth/login. We
 * cache it until ~1h after mint (Umami tokens are long-lived; we re-login on
 * any 401). If an api token is configured we send it as a Bearer / x-umami-api-key
 * and skip login entirely.
 */

const configStore = require('../../stores/configStore');
const { fallback } = require('../../utils/bestEffort');
const { KEY_URL, KEY_USERNAME, KEY_PASSWORD, KEY_API_TOKEN, ENDPOINT_CACHE_TTL_MS, TOKEN_TTL_MS, rawFetch, METRIC_TYPES, LEGACY_METRIC_TYPES, WEBSITE_WRITABLE_KEYS } = require('./umamiClientRawFetch');

/** @type {{ url: string | null, username: string, password: string, apiToken: string } | null} */
let _endpointCache = null;
let _endpointCacheAt = 0;

/** @type {string | null} */
let _token = null;
let _tokenAt = 0;

/**
 * Resolve the Umami endpoint + credentials. configStore wins; env is the
 * fallback so a fresh install can be wired purely via env. Cached briefly so a
 * burst of dashboard requests doesn't hammer the config table.
 */
async function getEndpoint() {
    const now = Date.now();
    if (_endpointCache && (now - _endpointCacheAt) < ENDPOINT_CACHE_TTL_MS) {
        return _endpointCache;
    }
    let cfgUrl = null, username = '', password = '', apiToken = '';
    try {
        cfgUrl = await configStore.getConfig(KEY_URL) || null;
        username = await configStore.getSecret(KEY_USERNAME) || '';
        password = await configStore.getSecret(KEY_PASSWORD) || '';
        apiToken = await configStore.getSecret(KEY_API_TOKEN) || '';
    } catch (err) { fallback('cms/umamiClient:config', err); /* fall through to env */ }
    // Server→Umami API base: prefer UMAMI_URL (an internal container hostname
    // like http://umami:3000 in compose) over the operator-set public URL, so
    // server calls work even when the public stats domain isn't routable from
    // inside the network. The public *script* origin is resolved separately
    // (cms_analytics_url) in routes/cms.js — don't conflate the two.
    let url = process.env.UMAMI_URL || cfgUrl || null;
    if (!username) username = process.env.UMAMI_USERNAME || '';
    if (!password) password = process.env.UMAMI_PASSWORD || '';
    if (!apiToken) apiToken = process.env.UMAMI_API_TOKEN || '';
    // Normalise: strip a trailing slash so `${url}/api/...` never doubles up.
    if (typeof url === 'string') url = url.replace(/\/+$/, '');
    _endpointCache = { url, username, password, apiToken };
    _endpointCacheAt = now;
    return _endpointCache;
}

function invalidateEndpointCache() {
    _endpointCache = null;
    _endpointCacheAt = 0;
    _token = null;
    _tokenAt = 0;
    // The operator may have just repointed us at a different Umami generation,
    // so the learned dimension-name flavour is no longer trustworthy.
    _legacyMetricNames = null;
}

/** True when enough config exists to actually reach Umami. */
async function isConfigured() {
    const e = await getEndpoint();
    return !!(e.url && (e.apiToken || (e.username && e.password)));
}

// ── Low-level request ────────────────────────────────────────────────

/**
 * Mint (or reuse) an auth token. Returns the header object to merge into a
 * request. Prefers a configured api token; otherwise logs in with user/pass.
 * @param {boolean} [forceRefresh]
 */
async function getAuthHeaders(forceRefresh = false) {
    const e = await getEndpoint();
    if (!e.url) throw new Error('Umami not configured (missing url)');

    if (e.apiToken) {
        // Cloud-style key works as a bearer on self-host too; also send the
        // dedicated header some deployments expect. No login round-trip.
        return { 'Authorization': `Bearer ${e.apiToken}`, 'x-umami-api-key': e.apiToken };
    }

    const now = Date.now();
    if (!forceRefresh && _token && (now - _tokenAt) < TOKEN_TTL_MS) {
        return { 'Authorization': `Bearer ${_token}` };
    }
    if (!e.username || !e.password) {
        throw new Error('Umami not configured (missing username/password)');
    }
    const r = await rawFetch('POST', `${e.url}/api/auth/login`, {
        body: { username: e.username, password: e.password },
    });
    if (!r.ok || !r.json?.token) {
        throw new Error(`Umami login failed (${r.status})`);
    }
    _token = r.json.token;
    _tokenAt = now;
    return { 'Authorization': `Bearer ${_token}` };
}

/**
 * Authenticated request with a single transparent re-login on 401. `query` is
 * an object of querystring params (undefined/null values are dropped).
 *
 * @param {string} method
 * @param {string} path
 * @param {{ query?: Record<string, unknown>, body?: object }} [opts]
 */
async function api(method, path, { query, body } = {}) {
    const e = await getEndpoint();
    if (!e.url) throw new Error('Umami not configured (missing url)');

    let qs = '';
    if (query && typeof query === 'object') {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null || v === '') continue;
            params.append(k, String(v));
        }
        const s = params.toString();
        if (s) qs = `?${s}`;
    }
    const fullUrl = `${e.url}${path}${qs}`;

    let headers = await getAuthHeaders();
    let r = await rawFetch(method, fullUrl, { headers, body });
    if (r.status === 401 && !e.apiToken) {
        // Token expired/revoked — re-login once and retry.
        headers = await getAuthHeaders(true);
        r = await rawFetch(method, fullUrl, { headers, body });
    }
    if (!r.ok) {
        // 600, not 200: Umami nests validation failures several levels deep
        // (`properties.replayConfig.properties.maskLevel.errors[0]`), and at 200
        // the message was cut off mid-sentence — right before the list of
        // accepted values, which is the only genuinely useful part.
        const err = new Error(`Umami ${method} ${path} → ${r.status}${r.text ? `: ${r.text.slice(0, 600)}` : ''}`);
        // Callers branch on the upstream status (the metric-name fallback below
        // keys off 400); parsing it back out of the message would be brittle.
        err.status = r.status;
        throw err;
    }
    return r.json;
}

/**
 * Read-only passthrough for the admin analytics proxy (routes/cmsAnalytics.js).
 * @param {string} path
 * @param {Record<string, unknown>} [query]
 */
function get(path, query) {
    return api('GET', path, { query });
}

/**
 * POST passthrough — report endpoints compute, they do not persist.
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 */
function post(path, body) {
    return api('POST', path, { body });
}

// ── Websites ─────────────────────────────────────────────────────────

/**
 * List websites. Returns an array regardless of v1/v2 response shape.
 * @returns {Promise<Array<{ id?: string, domain?: string, [k: string]: unknown }>>}
 */
async function listWebsites() {
    const res = await api('GET', '/api/websites', { query: { pageSize: 200 } });
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.data)) return res.data;
    return [];
}

/**
 * Find-or-create the Umami website for a CMS site. Matches an existing website
 * by domain first (so re-publishing the same site reuses its id), otherwise
 * creates one. Returns the Umami website id (UUID) or throws.
 * @param {{ name?: string, domain?: string }} site
 */
async function ensureWebsite({ name, domain }) {
    const cleanDomain = (domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (cleanDomain) {
        const existing = await listWebsites().catch((e) => fallback('core/cms/umamiClient:ensureWebsite', e, []));
        const match = existing.find(w => (w.domain || '').trim().toLowerCase() === cleanDomain);
        if (match?.id) return match.id;
    }
    const created = await api('POST', '/api/websites', {
        body: { name: name || cleanDomain || 'CMS site', domain: cleanDomain || 'cms.local' },
    });
    if (!created?.id) throw new Error('Umami website creation returned no id');
    return created.id;
}

// ── Stats ────────────────────────────────────────────────────────────

/**
 * Aggregate totals: { pageviews, visitors, visits, bounces, totaltime }.
 *
 * @param {string} websiteId
 * @param {{ startAt?: number, endAt?: number, [filter: string]: unknown }} [opts]
 */
// Extra keys are drill-down filters (country, browser, path…). The caller has
// already constrained them to METRIC_TYPES, and Umami reads them as top-level
// query params, so they can be forwarded as-is.
function getStats(websiteId, { startAt, endAt, ...filters } = {}) {
    return api('GET', `/api/websites/${websiteId}/stats`, { query: { startAt, endAt, ...filters } });
}

/**
 * Time series of pageviews + sessions over `unit` buckets.
 *
 * @param {string} websiteId
 * @param {{ startAt?: number, endAt?: number, unit?: string, timezone?: string, [filter: string]: unknown }} [opts]
 */
function getPageviews(websiteId, { startAt, endAt, unit = 'day', timezone = 'UTC', ...filters } = {}) {
    return api('GET', `/api/websites/${websiteId}/pageviews`, { query: { startAt, endAt, unit, timezone, ...filters } });
}

/** @type {boolean | null} */
let _legacyMetricNames = null;   // null = undetermined, true = server wants 2.x names

/**
 * Breakdown by dimension — see METRIC_TYPES. Returns [{ x: value, y: count }].
 *
 * `filters` are drill-down dimensions (country, browser, path…) forwarded to
 * Umami as extra query params. They must be spread into BOTH the primary and
 * the legacy call: dropping them on either path returns unfiltered rows, which
 * the proxy would then cache under a filter-specific key.
 *
 * @param {string} websiteId
 * @param {{ type?: string, startAt?: number, endAt?: number, limit?: number | string, filters?: Record<string, unknown> }} [opts]
 */
async function getMetrics(websiteId, { type, startAt, endAt, limit = 10, filters = {} } = {}) {
    /**
     * @param {string | undefined} t
     */
    const call = (t) => api('GET', `/api/websites/${websiteId}/metrics`, {
        query: { type: t, startAt, endAt, limit, ...filters },
    });
    const legacy = LEGACY_METRIC_TYPES[type];
    if (!legacy) return call(type);
    if (_legacyMetricNames === true) return call(legacy);
    try {
        return await call(type);
    } catch (err) {
        // Only a 400 means "unknown dimension"; a 401/500 must surface as-is.
        if (err?.status !== 400 || _legacyMetricNames !== null) throw err;
        const out = await call(legacy);
        _legacyMetricNames = true;
        return out;
    }
}

/** Unique visitors active in the last ~5 minutes. @param {string} websiteId */
function getActive(websiteId) {
    return api('GET', `/api/websites/${websiteId}/active`);
}

/**
 * The ONLY masking levels Umami accepts (verified against 3.2.0 — its schema is
 * a hard enum and anything else is a 400 on POST /api/websites/:id, nested under
 * `properties.replayConfig.properties.maskLevel`).
 *
 * This is exported so the admin route and its UI render exactly these options.
 * A parallel, friendlier vocabulary was tried once ('strict' | 'balanced' |
 * 'off') and silently worked only for 'strict' — the one value that happened to
 * overlap — while the other two were rejected upstream. Keep one list, here, at
 * the boundary that actually talks to Umami.
 *
 * Note there is deliberately no "no masking" option: 'moderate' is the loosest
 * level upstream offers.
 */
const MASK_LEVELS = Object.freeze(['strict', 'moderate']);

/**
 * Recorder settings for a Umami website (heatmaps + session replay).
 *
 * sampleRate defaults to 0.15 upstream — fine for a high-traffic app, useless
 * for a marketing site where you want to see the handful of real visits, so we
 * record everything unless told otherwise. maskLevel 'strict' is the
 * privacy-first choice for a product that gates this on explicit consent, and
 * is also the fallback for anything unrecognised: a stale value persisted by an
 * older build must not turn into a 400, and erring toward MORE masking is the
 * right failure direction for a privacy product.
 *
 * @param {{ enabled?: boolean, sampleRate?: number, maskLevel?: string }} [opts]
 */
function buildReplayConfig({ enabled, sampleRate = 1, maskLevel = 'strict' } = {}) {
    return {
        replayEnabled: !!enabled,
        heatmapEnabled: !!enabled,
        sampleRate: enabled ? sampleRate : 0,
        heatmapSampleRate: enabled ? sampleRate : 0,
        maskLevel: MASK_LEVELS.includes(maskLevel) ? maskLevel : 'strict',
    };
}

/**
 * Update recorder settings. Verifies the result rather than trusting the 200 —
 * Umami accepts unknown fields silently, so "it returned OK" proves nothing.
 * Returns the updated record.
 * @param {string} websiteId
 * @param {Record<string, unknown>} [patch]
 */
async function updateWebsite(websiteId, patch = {}) {
    /** @type {Record<string, unknown>} */
    const body = {};
    for (const k of WEBSITE_WRITABLE_KEYS) {
        if (patch[k] !== undefined) body[k] = patch[k];
    }
    if (!Object.keys(body).length) throw new Error('updateWebsite: no writable fields in patch');
    await api('POST', `/api/websites/${websiteId}`, { body });
    return api('GET', `/api/websites/${websiteId}`);
}

module.exports = {
    isConfigured,
    invalidateEndpointCache,
    ensureWebsite,
    listWebsites,
    updateWebsite,
    buildReplayConfig,
    getStats,
    getPageviews,
    getMetrics,
    getActive,
    get,
    post,
    METRIC_TYPES,
    MASK_LEVELS,
    WEBSITE_WRITABLE_KEYS,
    // exported for tests
    _internal: { getEndpoint, getAuthHeaders, api },
    KEY_URL, KEY_USERNAME, KEY_PASSWORD, KEY_API_TOKEN,
};
