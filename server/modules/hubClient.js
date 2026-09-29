/**
 * Hub client — the product side of the Bee Flow module Hub wire contract
 * (license.beeflow.nl / hub.beeflow.nl, `/hub/v1/*`).
 *
 * Owns exactly one concern: talking to the Hub over HTTP. It knows nothing
 * about packages, activation, entitlement persistence or capability wiring —
 * those live in packageLoader.js / entitlementRefresh.js / remoteCatalog.js.
 *
 * Persistence (via configStore) is the ONLY place the install identity lives:
 *   - beeflow_hub_url        (plain config)  — operator override of the Hub base
 *   - beeflow_hub_install_id (plain config)  — this install's id (public)
 *   - beeflow_hub_install_secret (secret)    — install secret (encrypted)
 *   - beeflow_hub_connection (plain config)  — { tier, subject, connectedAt } meta
 *
 * Networking: Node's global `fetch` (resolved at call time so tests can script
 * global.fetch) with AbortSignal.timeout — 6s for control-plane calls, 120s for
 * package downloads. Every failure surfaces as a HubError with a stable `code`
 * so callers/routes map to HTTP without string-matching messages.
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const { createTtlCache } = require('../utils/ttlCache');

const DEFAULT_HUB_URL = 'https://hub.beeflow.nl';
const HUB_URL_KEY = 'beeflow_hub_url';
const INSTALL_ID_KEY = 'beeflow_hub_install_id';
const INSTALL_SECRET_KEY = 'beeflow_hub_install_secret';
const CONNECTION_META_KEY = 'beeflow_hub_connection';

const REQUEST_TIMEOUT_MS = 6000;
const DOWNLOAD_TIMEOUT_MS = 120000;
// Compressed-size cap on a package download — slightly above the verifier's
// 200MB uncompressed total so a legitimate max-size package still fits, while
// a hostile endless stream can't fill the disk.
const MAX_DOWNLOAD_BYTES = 220 * 1024 * 1024;
const TOKEN_CACHE_MAX_MS = 50 * 60 * 1000; // ~50min — refresh well before the 1h exp
const CATALOG_TTL_MS = 5 * 60 * 1000;

// Lazy-require configStore: it self-inits DDL on load, and tests replace it via
// require.cache before this module reaches out.
let _configStore;
function configStore() { return _configStore || (_configStore = require('../stores/configStore')); }

function isProd() { return process.env.NODE_ENV === 'production'; }

/** Stable-coded error for every Hub failure. */
class HubError extends Error {
    constructor(code, message, { status = null, detail = null } = {}) {
        super(message || code);
        this.name = 'HubError';
        this.code = code;           // not_connected|hub_unavailable|hub_denied|not_entitled|already_entitled|checksum_mismatch|already_connected
        this.status = status;       // upstream HTTP status, when there was one
        this.detail = detail;       // upstream error slug, for surfacing
    }
}

// ── Access-token cache (install_access JWT minted from install_id+secret) ──
let _token = null; // { value, expiresAt }

function _reset() { _token = null; _meta = null; _catalogCache.clear(); _catalogLastGood.clear(); }
// Expire only the fresh TTL cache, keeping the last-good fallback — mirrors the
// production path where the 5-min TTL lapses but last-good survives.
function _expireCatalogCache() { _catalogCache.clear(); }

const _catalogCache = createTtlCache({ ttlMs: CATALOG_TTL_MS, max: 100 });
const _catalogLastGood = new Map(); // key → last successfully-fetched module list

function _trimUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

/**
 * Resolve the Hub base URL: env override → configStore → default. HTTPS is
 * enforced in production so a mis-set override can't downgrade to plaintext.
 */
async function resolveHubUrl() {
    let url = process.env.BEEFLOW_HUB_URL;
    if (!url) {
        try { url = await configStore().getConfig(HUB_URL_KEY); } catch (_) { /* default below */ }
    }
    url = _trimUrl(url) || DEFAULT_HUB_URL;
    if (isProd() && !/^https:\/\//i.test(url)) {
        throw new HubError('hub_unavailable', `refusing non-https Hub URL in production: ${url}`);
    }
    return url;
}

async function getInstallId() {
    try { return (await configStore().getConfig(INSTALL_ID_KEY)) || null; } catch (_) { return null; }
}
async function getInstallSecret() {
    try { return (await configStore().getSecret(INSTALL_SECRET_KEY)) || null; } catch (_) { return null; }
}

async function isConnected() {
    return !!(await getInstallId());
}

// ── Low-level fetch + response handling ───────────────────────────────────
function _mapHubError(status, code) {
    switch (code) {
        case 'invalid_credentials':
        case 'invalid_license':
        case 'license_revoked':
            return new HubError('hub_denied', code, { status, detail: code });
        case 'entitlement_required':
        case 'not_entitled':
            return new HubError('not_entitled', code, { status, detail: code });
        case 'already_entitled':
            return new HubError('already_entitled', code, { status, detail: code });
        case 'already_connected':
            return new HubError('already_connected', code, { status, detail: code });
        default: break;
    }
    if (status === 401 || status === 403) return new HubError('hub_denied', code || `hub_http_${status}`, { status, detail: code });
    if (status === 402) return new HubError('not_entitled', code || 'entitlement_required', { status, detail: code });
    if (status === 409) return new HubError('already_connected', code || 'conflict', { status, detail: code });
    return new HubError('hub_unavailable', code || `hub_http_${status}`, { status, detail: code });
}

async function _parseBody(resp) {
    const text = await resp.text().catch(() => '');
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
}

async function _rawFetch(method, url, { body = null, auth = false, timeoutMs = REQUEST_TIMEOUT_MS, forceToken = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${await _accessToken({ force: forceToken })}`;
    try {
        return await fetch(url, {
            method,
            headers,
            body: body != null ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        throw new HubError('hub_unavailable', `hub request failed: ${e.message}`, { detail: e.message });
    }
}

/** JSON request with a single silent token-refresh retry on a 401 for authed calls. */
async function _request(method, url, opts = {}) {
    let resp = await _rawFetch(method, url, opts);
    if (opts.auth && resp.status === 401) {
        resp = await _rawFetch(method, url, { ...opts, forceToken: true });
    }
    const data = await _parseBody(resp);
    if (resp.ok) return data || {};
    throw _mapHubError(resp.status, data && data.error);
}

/**
 * Mint (and cache) an install_access token from the persisted install
 * credentials. Cached for ~50min so we refresh comfortably before the 1h exp.
 */
async function _accessToken({ force = false } = {}) {
    if (!force && _token && _token.expiresAt > Date.now()) return _token.value;
    const installId = await getInstallId();
    const installSecret = await getInstallSecret();
    if (!installId || !installSecret) throw new HubError('not_connected', 'install is not connected to a Hub');
    const base = await resolveHubUrl();
    const data = await _request('POST', `${base}/hub/v1/token`, {
        body: { install_id: installId, install_secret: installSecret },
        auth: false,
    });
    if (!data || !data.access_token) throw new HubError('hub_unavailable', 'token response missing access_token');
    const expiresInMs = (Number(data.expires_in) || 3600) * 1000;
    _token = { value: data.access_token, expiresAt: Date.now() + Math.min(TOKEN_CACHE_MAX_MS, Math.max(60_000, expiresInMs - 60_000)) };
    return _token.value;
}

// ── Connect / disconnect ──────────────────────────────────────────────────
async function _defaultConnectParams() {
    const out = { license_token: null, product_version: null, hostname: null, contact_email: null };
    try { out.hostname = require('os').hostname(); } catch (_) { /* leave null */ }
    out.product_version = process.env.APP_VERSION || null;
    if (!out.product_version) {
        try { out.product_version = require('../../package.json').version || null; } catch (_) { /* leave null */ }
    }
    try {
        const lic = require('../license/store');
        const active = await lic.getActiveLicenseForServer();
        if (active && active.rawToken) out.license_token = active.rawToken;
    } catch (_) { /* unlicensed / community — connect anonymously */ }
    return out;
}

/**
 * Connect this install to the Hub. Persists install_id + secret on success.
 * @param {{ hubUrl?, licenseToken?, productVersion?, hostname?, contactEmail? }} params
 * @returns {Promise<{ install_id, tier, subject }>}
 */
async function connect(params = {}) {
    if (await isConnected()) throw new HubError('already_connected', 'install is already connected to a Hub');
    if (params.hubUrl) {
        const trimmed = _trimUrl(params.hubUrl);
        if (isProd() && !/^https:\/\//i.test(trimmed)) throw new HubError('hub_unavailable', 'Hub URL must be https in production');
        await configStore().setConfig(HUB_URL_KEY, trimmed);
    }
    const base = await resolveHubUrl();
    const defaults = await _defaultConnectParams();
    const body = {
        license_token: params.licenseToken ?? defaults.license_token,
        product_version: params.productVersion ?? defaults.product_version,
        hostname: params.hostname ?? defaults.hostname,
        contact_email: params.contactEmail ?? defaults.contact_email,
    };
    let data;
    try {
        data = await _request('POST', `${base}/hub/v1/connect`, { body, auth: false });
    } catch (e) {
        // The hub couldn't verify the auto-attached license token (e.g. an
        // install licensed against license.beeflow.nl talking to a local or
        // third-party hub with its own signing keys). An unverifiable license
        // must not block connecting — retry anonymously, which the hub accepts
        // as a community-tier install (exactly like an unlicensed one).
        const autoAttached = body.license_token && params.licenseToken == null;
        if (autoAttached && e && e.code === 'hub_denied' && e.detail === 'invalid_license') {
            data = await _request('POST', `${base}/hub/v1/connect`, {
                body: { ...body, license_token: null },
                auth: false,
            });
        } else {
            throw e;
        }
    }
    if (!data || !data.install_id || !data.install_secret) {
        throw new HubError('hub_unavailable', 'connect response missing install credentials');
    }
    await configStore().setConfig(INSTALL_ID_KEY, data.install_id);
    await configStore().setSecret(INSTALL_SECRET_KEY, data.install_secret);
    await configStore().setConfig(CONNECTION_META_KEY, {
        tier: data.tier || null,
        subject: data.subject || null,
        connectedAt: new Date().toISOString(),
    });
    _token = null;
    return { install_id: data.install_id, tier: data.tier || null, subject: data.subject || null };
}

async function disconnect() {
    await configStore().setConfig(INSTALL_ID_KEY, '');
    await configStore().setSecret(INSTALL_SECRET_KEY, '');
    await configStore().setConfig(CONNECTION_META_KEY, '');
    _token = null;
    return { ok: true };
}

/** Snapshot of the connection for the admin surface. */
async function getConnection() {
    const installId = await getInstallId();
    let hubUrl = DEFAULT_HUB_URL;
    try { hubUrl = await resolveHubUrl(); } catch (_) { /* keep default */ }
    let meta = {};
    try { meta = (await configStore().getConfig(CONNECTION_META_KEY)) || {}; } catch (_) { /* none */ }
    return {
        connected: !!installId,
        hubUrl,
        installId: installId || null,
        tier: meta.tier || null,
        subject: meta.subject || null,
        connectedAt: meta.connectedAt || null,
    };
}

// ── Catalog (public) ──────────────────────────────────────────────────────
// A v1 hub has no /hub/v1/meta (404) ⇒ { hub_api: 1, features: [] } — callers
// then suppress v2 request params and the SPA hides v2-only UI. Memoized
// ~60min with a configStore last-good so a hub blip doesn't flap features off.
const META_TTL_MS = 60 * 60 * 1000;
const META_LASTGOOD_KEY = 'beeflow_hub_meta';
let _meta = null; // { value, fetchedAt }

async function fetchMeta() {
    if (_meta && (Date.now() - _meta.fetchedAt) < META_TTL_MS) return _meta.value;
    const base = await resolveHubUrl();
    try {
        const resp = await _rawFetch('GET', `${base}/hub/v1/meta`, { auth: false });
        let value;
        if (resp.status === 404) {
            value = { hub_api: 1, features: [] };
        } else if (resp.ok) {
            const data = await _parseBody(resp);
            value = {
                hub_api: Number(data && data.hub_api) || 1,
                features: Array.isArray(data && data.features) ? data.features : [],
            };
        } else {
            throw _mapHubError(resp.status, null);
        }
        _meta = { value, fetchedAt: Date.now() };
        configStore().setConfig(META_LASTGOOD_KEY, value).catch(() => {});
        return value;
    } catch (_) {
        try {
            const lastGood = await configStore().getConfig(META_LASTGOOD_KEY);
            if (lastGood && typeof lastGood === 'object') return lastGood;
        } catch (_) { /* fall through */ }
        return { hub_api: 1, features: [] };
    }
}

async function hubHasFeature(feature) {
    const meta = await fetchMeta();
    return (meta.features || []).includes(feature);
}

function _catalogQuery({ q = '', category = '', cursor = '', limit = 0 } = {}) {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (category) p.set('category', category);
    if (cursor) p.set('cursor', String(cursor));
    if (limit) p.set('limit', String(limit));
    const s = p.toString();
    return s ? `?${s}` : '';
}

async function fetchCatalog({ q = '', category = '', cursor = '', limit = 0 } = {}) {
    const base = await resolveHubUrl();
    // Pagination is opt-in AND feature-negotiated: never send v2 params to a
    // v1 hub (it would ignore them and we'd misreport nextCursor).
    let useCursor = false;
    if (cursor || limit) {
        try { useCursor = await hubHasFeature('catalog_cursor'); } catch (_) { useCursor = false; }
    }
    const qs = _catalogQuery(useCursor ? { q, category, cursor, limit } : { q, category });
    const data = await _request('GET', `${base}/hub/v1/catalog${qs}`, { auth: false });
    return {
        modules: Array.isArray(data.modules) ? data.modules : [],
        nextCursor: useCursor ? (data.next_cursor || null) : null,
    };
}

/**
 * 5-minute TTL-cached catalog with a per-query last-good fallback: when the Hub
 * is unreachable we return the last successful list flagged `stale:true` rather
 * than 502ing the marketplace. Cold-cache failures still throw.
 */
async function fetchCatalogCached({ q = '', category = '', cursor = '', limit = 0 } = {}) {
    const key = [q, category, cursor, limit].join('|');
    const cached = _catalogCache.get(key);
    if (cached) return { modules: cached.modules, nextCursor: cached.nextCursor || null, stale: false };
    try {
        const page = await fetchCatalog({ q, category, cursor, limit });
        _catalogCache.set(key, page);
        _catalogLastGood.set(key, page);
        return { modules: page.modules, nextCursor: page.nextCursor, stale: false };
    } catch (e) {
        const lastGood = _catalogLastGood.get(key);
        if (lastGood) return { modules: lastGood.modules, nextCursor: lastGood.nextCursor || null, stale: true };
        throw e;
    }
}

async function fetchCatalogEntry(moduleId) {
    const base = await resolveHubUrl();
    return _request('GET', `${base}/hub/v1/catalog/${encodeURIComponent(moduleId)}`, { auth: false });
}

// ── Entitlements / purchases (authed) ─────────────────────────────────────
async function fetchEntitlements() {
    const base = await resolveHubUrl();
    const data = await _request('GET', `${base}/hub/v1/entitlements`, { auth: true });
    return {
        as_of: data.as_of || null,
        entitlements: Array.isArray(data.entitlements) ? data.entitlements : [],
    };
}

async function createPurchase({ moduleId, priceId, successUrl = null, cancelUrl = null } = {}) {
    const base = await resolveHubUrl();
    const body = { module_id: moduleId, price_id: priceId };
    if (successUrl) body.success_url = successUrl;
    if (cancelUrl) body.cancel_url = cancelUrl;
    return _request('POST', `${base}/hub/v1/purchases`, { body, auth: true });
}

async function getPurchase(purchaseId) {
    const base = await resolveHubUrl();
    return _request('GET', `${base}/hub/v1/purchases/${encodeURIComponent(purchaseId)}`, { auth: true });
}

async function fetchRevocationList({ since = 0, limit = 500 } = {}) {
    const base = await resolveHubUrl();
    const p = new URLSearchParams();
    if (since) p.set('since', String(since));
    if (limit) p.set('limit', String(limit));
    const s = p.toString();
    return _request('GET', `${base}/hub/v1/grants/revocation-list${s ? `?${s}` : ''}`, { auth: false });
}

// ── Package download (authed, streamed) ───────────────────────────────────
async function _streamToFileAndHash(resp, partPath) {
    const hash = crypto.createHash('sha256');
    const fh = await fsp.open(partPath, 'w');
    let total = 0;
    const cap = (chunkLen) => {
        total += chunkLen;
        if (total > MAX_DOWNLOAD_BYTES) throw new Error(`package exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
    };
    try {
        if (resp.body && typeof resp.body.getReader === 'function') {
            for await (const chunk of Readable.fromWeb(resp.body)) {
                cap(chunk.length);
                hash.update(chunk);
                await fh.write(chunk);
            }
        } else {
            // Non-streaming Response (e.g. scripted in tests): buffer once.
            const buf = Buffer.from(await resp.arrayBuffer());
            cap(buf.length);
            hash.update(buf);
            await fh.write(buf);
        }
    } finally {
        await fh.close();
    }
    return hash.digest('hex');
}

/**
 * Download a `.bfmod` to `destPath`. Streams to `<destPath>.part`, verifies the
 * sha256 (against the caller's `expectedSha256` when given, else the
 * X-BeeFlow-Package-Sha256 header), then atomically renames into place.
 * @returns {Promise<{ path, sha256, signature, kid }>}
 */
async function downloadPackage({ moduleId, version, destPath, expectedSha256 = null, redownloadSha = null } = {}) {
    const base = await resolveHubUrl();
    // ?redownload=sha256:<hex> is the yank carve-out: an entitled install
    // re-fetching the EXACT bytes it already ledgered may do so even for a
    // yanked version (self-heal); fresh installs of a yanked version still 410.
    const redl = redownloadSha ? `?redownload=sha256:${encodeURIComponent(String(redownloadSha).toLowerCase())}` : '';
    const url = `${base}/hub/v1/modules/${encodeURIComponent(moduleId)}/versions/${encodeURIComponent(version)}/download${redl}`;
    const token = await _accessToken();
    let resp;
    try {
        resp = await fetch(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
    } catch (e) {
        throw new HubError('hub_unavailable', `package download failed: ${e.message}`, { detail: e.message });
    }
    if (!resp.ok) {
        const data = await _parseBody(resp);
        throw _mapHubError(resp.status, data && data.error);
    }

    const headerSha = resp.headers.get('X-BeeFlow-Package-Sha256') || resp.headers.get('x-beeflow-package-sha256') || null;
    const signature = resp.headers.get('X-BeeFlow-Package-Signature') || resp.headers.get('x-beeflow-package-signature') || null;
    const kid = resp.headers.get('X-BeeFlow-Signing-Kid') || resp.headers.get('x-beeflow-signing-kid') || null;

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const partPath = `${destPath}.part`;
    let digest;
    try {
        digest = await _streamToFileAndHash(resp, partPath);
    } catch (e) {
        await fsp.rm(partPath, { force: true }).catch(() => {});
        throw new HubError('hub_unavailable', `package write failed: ${e.message}`, { detail: e.message });
    }

    const expected = expectedSha256 || headerSha;
    if (expected && digest.toLowerCase() !== String(expected).toLowerCase()) {
        await fsp.rm(partPath, { force: true }).catch(() => {});
        throw new HubError('checksum_mismatch', `package sha256 mismatch (expected ${expected}, got ${digest})`);
    }
    await fsp.rename(partPath, destPath);
    return { path: destPath, sha256: digest, signature, kid };
}

// ── Licence rebind (M4.5) ──────────────────────────────────────────────────
/**
 * Tell the hub the install's server licence was replaced, so it migrates
 * license-bound entitlements to the new license_id. A v1 hub 404s — swallowed
 * (the product-side license-id history carries the load there). Returns
 * { ok, rebound } and never throws on a missing endpoint.
 */
async function rebindLicense() {
    let token = null;
    try {
        const active = await require('../license/store').getActiveLicenseForServer();
        token = active && active.rawToken;
    } catch (_) { /* unlicensed */ }
    if (!token) return { ok: false, rebound: false, reason: 'no_license' };
    const base = await resolveHubUrl();
    try {
        const data = await _request('POST', `${base}/hub/v1/rebind`, {
            body: { license_token: token }, auth: true,
        });
        return { ok: true, rebound: true, ...data };
    } catch (e) {
        if (e && e.status === 404) return { ok: true, rebound: false, reason: 'v1_hub' };
        throw e;
    }
}

module.exports = {
    HubError,
    resolveHubUrl,
    isConnected,
    connect,
    disconnect,
    getConnection,
    getInstallId,
    fetchMeta,
    hubHasFeature,
    fetchCatalog,
    fetchCatalogCached,
    fetchCatalogEntry,
    fetchEntitlements,
    createPurchase,
    getPurchase,
    fetchRevocationList,
    downloadPackage,
    rebindLicense,
    // exposed for tests / boot cache-busting
    _accessToken,
    _reset,
    _expireCatalogCache,
    // config keys (shared with routes/tests)
    HUB_URL_KEY,
    INSTALL_ID_KEY,
    INSTALL_SECRET_KEY,
    CONNECTION_META_KEY,
};
