// @typecheck strict

// ── Config keys ──────────────────────────────────────────────────────
const KEY_URL       = 'cms_analytics_url';

const KEY_USERNAME  = 'cms_analytics_username';

const KEY_PASSWORD  = 'cms_analytics_password';

const KEY_API_TOKEN = 'cms_analytics_api_token';

const ENDPOINT_CACHE_TTL_MS = 10_000;

// Re-login proactively well before any realistic token lifetime; a 401 also
// forces a refresh, so this is just a safety margin, not a hard expiry.
const TOKEN_TTL_MS = 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 12_000;

/**
 * @param {string} method
 * @param {string} fullUrl
 * @param {{ headers?: Record<string, string>, body?: object }} [opts]
 */
async function rawFetch(method, fullUrl, { headers = {}, body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(fullUrl, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
            },
            body: body != null ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        return { status: res.status, ok: res.ok, json, text };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Breakdown dimensions accepted by Umami 3.x `/metrics` and `/values`.
 * Anything outside this set is a 400 upstream, so the proxy validates against it.
 */
const METRIC_TYPES = Object.freeze([
    'path', 'referrer', 'title', 'query', 'os', 'browser', 'device',
    'country', 'region', 'city', 'tag', 'hostname', 'distinctId', 'language',
    'event', 'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm',
]);

// Umami 2.x called the page-path dimension `url`; 3.x renamed it to `path` and
// rejects the old name with a hard 400. We always send the 3.x name and fall
// back ONCE per process if the server turns out to be a 2.x install, so both
// generations work without the operator configuring a version anywhere.
/** @type {Readonly<Record<string, string>>} */
const LEGACY_METRIC_TYPES = Object.freeze({ path: 'url' });

// The ONLY write this client performs. Kept to a closed key set so a bug in the
// caller can never rename, re-domain or reset a website.
//
// `recorderEnabled` is deliberately NOT writable: Umami derives it from
// replayConfig and silently ignores the field if you send it (the request still
// returns 200, so the caller would think it worked). Send replayConfig.
const WEBSITE_WRITABLE_KEYS = Object.freeze(['replayConfig']);

module.exports = { KEY_URL, KEY_USERNAME, KEY_PASSWORD, KEY_API_TOKEN, ENDPOINT_CACHE_TTL_MS, TOKEN_TTL_MS, rawFetch, METRIC_TYPES, LEGACY_METRIC_TYPES, WEBSITE_WRITABLE_KEYS };
