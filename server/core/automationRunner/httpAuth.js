/**
 * HTTP-credential resolution for the http_request automation step (Feature C).
 *
 * A step opts in via `step.auth = { connectionId }` referencing a provider
 * 'http' row in integration_connections. This module authorizes the run's
 * owner against that connection (own-or-grant, org-isolated), decrypts the
 * secret, renders the per-kind auth header(s), and returns the exact secret
 * strings for masking. For kind oauth2_cc it fetches a client-credentials
 * access token with a module-level cache + single-flight so loops/parallel
 * branches don't hammer the token endpoint.
 *
 * Security invariants:
 *  - Thrown messages NEVER contain secret material (token endpoint bodies are
 *    dropped; only a well-formed OAuth error code may pass through).
 *  - Mask values are handed back for runState[MASK_VALUES] — a Symbol.for key
 *    that templates/exprs/code steps cannot reach (bind.js walks string paths
 *    only), so a lent credential is maskable without being readable.
 *  - Only provider 'http' connections are accepted: without this, a step
 *    could point http_request at an attacker URL with a LENT github/fireflies
 *    connection and exfiltrate its raw token.
 *  - Host binding (D18): a step whose `auth.allowedHosts` is a non-empty array
 *    (a Solution stage's `connection` binding writes it) only gets the
 *    credential for a request whose URL hostname is listed (exact match,
 *    lower-case, no port). Checked BEFORE the store is touched, with the same
 *    opaque message as forbidden, so a stage value such as
 *    `{{vars.api_base}}` cannot steer the owner's credential to another host.
 *    A step without the list behaves as before. The check is only as good as
 *    its caller: execOutbound.js must pass the step's `auth` (or
 *    `allowedHosts: step.auth.allowedHosts`) and the resolved `url`. Until it
 *    does, the binding is NOT enforced: omitting the list FAILS OPEN (no
 *    binding, the credential goes to any host). With the list and no `url`
 *    it fails closed. A redirect to another host after the credential is
 *    attached is the caller's to refuse.
 *
 * Engine → httpAuth is the only require direction (no cycle); the store and
 * ssrfGuard are required lazily so test harnesses can pre-mock them.
 */

const MASK_VALUES = Symbol.for('beeflow.automation.maskValues');

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_FETCH_TIMEOUT_MS = 10_000;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

// oauth2_cc token cache. Key includes updatedAt so a secret rotation (which
// bumps updated_at) naturally invalidates. inflight dedupes concurrent
// fetches for the same key (single-flight).
const tokenCache = new Map();   // key -> { token, expiresAt }
const inflight = new Map();     // key -> Promise<string>

function cacheKey(conn) {
    return `${conn.id}:${Date.parse(conn.updatedAt) || 0}`;
}

const NOT_AVAILABLE_MSG = "http_request: the referenced HTTP credential is not available to this automation's owner. Pick one of your own credentials in the step's Authentication settings.";

/** Lower-case hostname of a URL (no port, no brackets stripped), or null when it does not parse. */
function hostnameOf(url) {
    try { return new URL(String(url)).hostname.toLowerCase() || null; } catch (_) { return null; }
}

/**
 * Is a request to `url` allowed by a step's `allowedHosts`? No list (absent,
 * not an array, or empty) allows everything, as before host binding. A list
 * allows exactly the hostnames on it; a URL that does not parse, or a list
 * with no usable entry, allows nothing.
 */
function hostAllowed(allowedHosts, url) {
    if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return true;
    const host = hostnameOf(url);
    if (!host) return false;
    return allowedHosts.some((h) => typeof h === 'string' && h.trim().toLowerCase() === host);
}

/**
 * Resolve the auth header(s) for a step referencing `connectionId`.
 * `allowedHosts` is the step's `auth.allowedHosts`, `url` the resolved request
 * URL it is checked against (D18).
 * ctx: the run context ({ userId, orgId, userGroupIds }).
 * deps ({ fetchImpl, now, store }) is test-only injection.
 *
 * → { headers: {name: value}, maskValues: string[], label, accessMode }
 * Throws user-safe Errors; never includes secret material.
 */
async function resolveHttpAuthHeaders({ connectionId, blockPrivateTargets = true, allowedHosts = null, auth = null, url = null }, ctx, deps = {}) {
    // `auth` (the step's whole auth object) is the preferred way to pass the
    // list: a caller that hands over the step's auth cannot forget its hosts.
    const hosts = allowedHosts ?? (auth && typeof auth === 'object' ? auth.allowedHosts : null);
    if (!hostAllowed(hosts, url)) throw new Error(NOT_AVAILABLE_MSG);
    const store = deps.store || require('../../stores/integrationConnectionStore');
    const authz = await store.authorizeConnectionUse({
        connectionId,
        runningUserId: ctx.userId,
        runningUserOrgId: ctx.orgId,
        runningUserGroups: ctx.userGroupIds || [],
    });
    if (!authz.ok) {
        if (authz.reason === 'not_found' || authz.reason === 'forbidden') {
            throw new Error(NOT_AVAILABLE_MSG);
        }
        const label = authz.connection?.label || 'credential';
        throw new Error(`http_request: HTTP credential "${label}" needs attention (${authz.reason}). Update it in Settings → Integrations.`);
    }
    const conn = authz.connection;
    if (conn.provider !== 'http') {
        // Cross-provider exfiltration guard — same opaque message as forbidden.
        throw new Error(NOT_AVAILABLE_MSG);
    }

    const full = await store.getConnectionWithSecret(connectionId);
    const secret = full?.secret;
    if (!secret || typeof secret !== 'object' || Object.keys(secret).length === 0) {
        throw new Error(`http_request: HTTP credential "${conn.label}" could not be decrypted — re-enter this credential in Settings → Integrations.`);
    }

    const { renderAuthValue } = require('../../integrations/customIntegrationRunner');
    const headers = {};
    const maskValues = [];
    // Every raw secret string is a mask needle, plus every DERIVED header
    // value (Basic base64, "Bearer …", fetched token) — redactForPersistence
    // exact-matches, so derived strings must be listed explicitly.
    for (const v of Object.values(secret)) {
        if (typeof v === 'string' && v) maskValues.push(v);
    }

    switch (conn.kind) {
        case 'bearer': {
            const value = renderAuthValue({ type: 'bearer', valueTemplate: 'Bearer {{credential.token}}' }, secret);
            headers.Authorization = value;
            maskValues.push(value);
            break;
        }
        case 'api_key': {
            const headerName = conn.secretMeta?.headerName;
            // Defense in depth: meta is non-secret but re-validate the charset
            // so a hand-edited row can't smuggle a malformed header name.
            if (typeof headerName !== 'string' || !HEADER_NAME_RE.test(headerName)) {
                throw new Error(`http_request: HTTP credential "${conn.label}" has an invalid header name — re-save it in Settings → Integrations.`);
            }
            const value = renderAuthValue({ type: 'header', valueTemplate: '{{credential.token}}' }, secret);
            headers[headerName] = value;
            maskValues.push(value);
            break;
        }
        case 'basic': {
            const value = renderAuthValue({ type: 'basic' }, secret);
            headers.Authorization = value;
            maskValues.push(value);
            break;
        }
        case 'oauth2_cc': {
            const token = await getOAuth2Token(conn, secret, { blockPrivateTargets }, deps);
            headers.Authorization = `Bearer ${token}`;
            maskValues.push(token, `Bearer ${token}`);
            break;
        }
        default:
            throw new Error(`http_request: HTTP credential "${conn.label}" has an unsupported kind — re-create it in Settings → Integrations.`);
    }

    store.touchLastUsed(connectionId).catch(() => {});
    // `fingerprint` is what the response cache puts in its key INSTEAD of the
    // header value — the identity string is plaintext in memory before it is
    // hashed, so a live bearer token must never be part of it. It is the same
    // value cacheKey() already computes for the token cache plus the access
    // mode, so a secret rotation bumps updated_at and invalidates the cached
    // answer for free, and an own-use and a delegated use never share one.
    return {
        headers, maskValues, label: conn.label, accessMode: authz.mode,
        fingerprint: `${cacheKey(conn)}:${authz.mode}`,
        // The grant this use was authorized by, or null for own use. execAi
        // puts grantId in its key precisely so two lends of one connection
        // cannot share an answer.
        grantId: authz.grantId || null,
    };
}

/** Cached + single-flight client-credentials token for one connection. */
async function getOAuth2Token(conn, secret, { blockPrivateTargets = true } = {}, deps = {}) {
    const now = deps.now || Date.now;
    const key = cacheKey(conn);
    // Prune dead entries (incl. stale keys from rotated secrets).
    for (const [k, v] of tokenCache) {
        if (v.expiresAt <= now()) tokenCache.delete(k);
    }
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - now() > TOKEN_REFRESH_MARGIN_MS) return cached.token;
    if (inflight.has(key)) return inflight.get(key);
    const p = fetchOAuth2Token(conn, secret, { blockPrivateTargets }, deps)
        .then((entry) => { tokenCache.set(key, entry); return entry.token; })
        .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

async function fetchOAuth2Token(conn, secret, { blockPrivateTargets }, deps) {
    const meta = conn.secretMeta || {};
    let tokenUrl = null;
    try { tokenUrl = new URL(String(meta.tokenUrl || '')); } catch (_) { /* handled below */ }
    if (!tokenUrl || (tokenUrl.protocol !== 'http:' && tokenUrl.protocol !== 'https:')) {
        throw new Error(`http_request: HTTP credential "${conn.label}" has an invalid OAuth2 token URL — fix it in Settings → Integrations.`);
    }

    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    if (typeof meta.scope === 'string' && meta.scope.trim()) params.set('scope', meta.scope.trim());
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (meta.tokenAuthMethod === 'client_secret_basic') {
        headers.Authorization = 'Basic ' + Buffer.from(`${secret.client_id}:${secret.client_secret}`, 'utf8').toString('base64');
    } else {
        params.set('client_id', secret.client_id);
        params.set('client_secret', secret.client_secret);
    }

    const { safeFetch, isPrivateAddressError } = require('../../utils/ssrfGuard');
    // Same SSRF semantics as the step's main request: the guarded safeFetch
    // unless the step explicitly opted out of blocking private targets.
    const fetchImpl = deps.fetchImpl || (blockPrivateTargets ? safeFetch : fetch);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TOKEN_FETCH_TIMEOUT_MS);
    let resp;
    try {
        resp = await fetchImpl(tokenUrl.toString(), {
            method: 'POST', headers, body: params.toString(), signal: ac.signal,
        });
    } catch (e) {
        if (blockPrivateTargets && isPrivateAddressError(e)) {
            throw new Error(`http_request: refused — the OAuth2 token URL for credential "${conn.label}" resolves to a private/internal address.`);
        }
        if (e.name === 'AbortError') {
            throw new Error(`http_request: the OAuth2 token request for credential "${conn.label}" timed out after ${TOKEN_FETCH_TIMEOUT_MS}ms.`);
        }
        // Sanitized: network error text can echo the URL but never a secret.
        throw new Error(`http_request: could not reach the OAuth2 token endpoint for credential "${conn.label}" — check the token URL in Settings.`);
    } finally {
        clearTimeout(timer);
    }

    const text = await resp.text().catch(() => '');
    if (resp.status === 400 || resp.status === 401) {
        // Bad client credentials (or malformed grant): flag the connection so
        // the UI prompts a re-enter. NEVER include the response body — only a
        // well-formed OAuth error code may pass through.
        let code = null;
        try {
            const j = JSON.parse(text);
            if (typeof j.error === 'string' && /^[a-z0-9_]+$/i.test(j.error)) code = j.error;
        } catch (_) { /* body stays out of the message */ }
        try {
            const store = deps.store || require('../../stores/integrationConnectionStore');
            await store.markNeedsReauth(conn.id, `OAuth2 token endpoint rejected the client credentials (HTTP ${resp.status})`);
        } catch (_) { /* best effort */ }
        throw new Error(`http_request: could not obtain an OAuth2 access token for credential "${conn.label}" (token endpoint returned ${resp.status}${code ? `, error "${code}"` : ''}). Check the token URL and client credentials in Settings.`);
    }
    if (!resp.ok) {
        throw new Error(`http_request: the OAuth2 token endpoint for credential "${conn.label}" returned HTTP ${resp.status}.`);
    }
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* handled below */ }
    if (!json || typeof json.access_token !== 'string' || !json.access_token) {
        throw new Error(`http_request: the OAuth2 token endpoint for credential "${conn.label}" did not return an access_token.`);
    }
    const expiresIn = Math.min(Math.max(Number(json.expires_in) || 3600, 60), 86400);
    return { token: json.access_token, expiresAt: (deps.now || Date.now)() + expiresIn * 1000 };
}

/**
 * Drop every cached token for a connection (all updatedAt variants). Called
 * by execHttpRequest when the TARGET API returns 401 so a stale-but-unexpired
 * token is refetched on the next attempt instead of failing the retry too.
 */
function evictToken(connectionId) {
    const prefix = `${connectionId}:`;
    for (const k of tokenCache.keys()) {
        if (k.startsWith(prefix)) tokenCache.delete(k);
    }
}

module.exports = {
    MASK_VALUES,
    resolveHttpAuthHeaders,
    evictToken,
    hostAllowed,
    _internals: { tokenCache, inflight, cacheKey, getOAuth2Token },
};
