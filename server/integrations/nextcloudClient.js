/**
 * Nextcloud Client — Shared HTTP helper for OAuth Bearer access to WebDAV + OCS.
 *
 * Mirrors msGraphClient.js: a single fetch wrapper that injects the Bearer
 * token from the session and transparently refreshes on 401 using the stored
 * refresh token. Used by nextcloudTools.js when the session is in OAuth mode;
 * the Basic-auth (app-password) path bypasses this module entirely.
 */

const { loadConfig } = require('../auth/permissions');
const configStore = require('../stores/configStore');
const { assertAllowedNextcloudHost, isMetadataHost, nextcloudFetch } = require('./nextcloudTarget');
const { signedConnectorHeaders } = require('./ncSigning');
const log = require('../telemetry/log');

const REQUEST_TIMEOUT_MS = 20000;

/**
 * Locate the Nextcloud token "slot" inside a session, regardless of whether
 * Nextcloud is the primary OAuth provider or a secondary one.
 *
 * Two cases:
 *   1. Browser session / Nextcloud-only automation: tokens live at session.accessToken
 *      / session.refreshToken / session.nextcloudUid (legacy shape).
 *   2. Multi-integration automation: automationAuth.buildUserAuth() may have picked
 *      a different primary (Google/Microsoft), with Nextcloud's tokens placed
 *      under session.automationProviders.nextcloud.
 *
 * Returns the same object both readers and the refresh path can mutate, so a
 * mid-automation token refresh propagates to subsequent calls in the same fire.
 * Returns null when no Nextcloud creds are present in either slot.
 */
function getNextcloudCredsRef(session) {
    if (!session) return null;
    if (session.oauthProvider === 'nextcloud' && session.accessToken) {
        // Legacy/primary slot — refresh writes back here.
        return {
            get accessToken() { return session.accessToken; },
            set accessToken(v) { session.accessToken = v; },
            get refreshToken() { return session.refreshToken; },
            set refreshToken(v) { session.refreshToken = v; },
            get expiresAt() { return session.nextcloudTokenExpiresAt; },
            set expiresAt(v) { session.nextcloudTokenExpiresAt = v; },
            get uid() { return session.nextcloudUid; },
            set uid(v) { session.nextcloudUid = v; },
            persist: () => session.save?.(),
        };
    }
    const sub = session.automationProviders?.nextcloud;
    if (sub && sub.accessToken) {
        return {
            get accessToken() { return sub.accessToken; },
            set accessToken(v) { sub.accessToken = v; },
            get refreshToken() { return sub.refreshToken; },
            set refreshToken(v) { sub.refreshToken = v; },
            get expiresAt() { return sub.expiresAt; },
            set expiresAt(v) { sub.expiresAt = v; },
            get uid() { return sub.nextcloudUid; },
            set uid(v) { sub.nextcloudUid = v; },
            // automationProviders is in-memory only — no persist hook, but
            // automationAuth refreshes from the encrypted vault next fire anyway.
            persist: () => {},
        };
    }
    return null;
}

function isNextcloudOAuthSession(session) {
    return !!getNextcloudCredsRef(session);
}

// Resolve the Nextcloud base URL. A per-user URL (saved alongside the app
// password in Settings → Connections) takes precedence; otherwise fall back to
// the org-wide oauth.nextcloudUrl. Pass `overrideUrl` from the user's creds.
//
// SSRF: the per-user URL is attacker-controlled input and gets the full target
// check (private addresses refused unless the deployment opted in). The
// org-wide default is set by an admin who can already point this integration
// anywhere, so it only gets the unconditional metadata-endpoint block —
// otherwise this check would break existing LAN self-host installs on upgrade.
async function getBaseUrl(overrideUrl) {
    const userSupplied = (overrideUrl || '').trim().replace(/\/+$/, '');
    if (userSupplied) {
        assertAllowedNextcloudHost(userSupplied);
        return userSupplied;
    }
    const oauth = (await configStore.getConfig('oauth')) || {};
    const url = (oauth.nextcloudUrl || '').replace(/\/+$/, '');
    if (!url) throw new Error('Nextcloud URL not configured. Add your Nextcloud URL in Settings → Connections, or ask an admin to set the organisation default.');
    if (isMetadataHost(new URL(url).hostname)) {
        throw new Error('The configured Nextcloud URL is not a valid host.');
    }
    return url;
}

function webdavRoot(baseUrl, uid) {
    return `${baseUrl}/remote.php/dav/files/${encodeURIComponent(uid)}`;
}

/**
 * In-flight refreshes, keyed by the session object itself.
 *
 * Nextcloud rotates refresh tokens: the first successful `grant_type=refresh_token`
 * invalidates the token it was called with. An automation that fans out several
 * Nextcloud tool calls in parallel hits 401 on all of them at once, and without
 * this guard each one races to redeem the same (now single-use) refresh token —
 * one wins, the rest fail, and the last writer persists a dead token, logging
 * the user out mid-run. A WeakMap keyed on the session lets concurrent callers
 * share one refresh and keeps no entry alive past the session itself.
 */
const _refreshInFlight = new WeakMap();

/**
 * Refresh the Nextcloud OAuth access token using the refresh token. Writes
 * back to whichever slot held the original credentials (primary OR
 * automationProviders.nextcloud) so subsequent calls in the same fire pick up
 * the new token.
 *
 * Concurrent calls for the same session share a single network round-trip.
 */
async function refreshAccessToken(session) {
    if (session && _refreshInFlight.has(session)) {
        return _refreshInFlight.get(session);
    }
    const promise = _doRefreshAccessToken(session);
    if (session) {
        _refreshInFlight.set(session, promise);
        // Clear on settle either way: a failed refresh must not pin the
        // rejection for the life of the session.
        promise.catch(() => {}).finally(() => _refreshInFlight.delete(session));
    }
    return promise;
}

async function _doRefreshAccessToken(session) {
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};

    if (!nextcloudUrl || !clientId || !clientSecret) {
        throw new Error('Nextcloud OAuth not configured');
    }

    const creds = getNextcloudCredsRef(session);
    const refreshToken = creds?.refreshToken;
    if (!refreshToken) {
        throw new Error('No refresh token available — user must re-authenticate with Nextcloud');
    }

    const response = await nextcloudFetch(`${nextcloudUrl.replace(/\/+$/, '')}/apps/oauth2/api/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        }).toString(),
    });

    if (!response.ok) {
        // Log the status and a validated OAuth error code only — never the raw
        // provider body, which is unbounded and sits on a credential path.
        const body = await response.text().catch(() => '');
        let code = '';
        try {
            const parsed = JSON.parse(body);
            if (typeof parsed?.error === 'string' && /^[a-z_]{1,40}$/.test(parsed.error)) code = parsed.error;
        } catch (_) { /* non-JSON body — status alone is the signal */ }
        log.error(`[Nextcloud] Token refresh failed (${response.status})${code ? `: ${code}` : ''}`);
        throw new Error('Nextcloud token refresh failed — user must re-authenticate');
    }

    const tokenData = await response.json();

    if (tokenData.access_token) creds.accessToken = tokenData.access_token;
    // Nextcloud rotates refresh tokens; always overwrite when present.
    if (tokenData.refresh_token) creds.refreshToken = tokenData.refresh_token;
    if (tokenData.expires_in) creds.expiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
    creds.persist();

    return tokenData.access_token;
}

/**
 * Process-level uid cache, keyed by Bee Flow user id.
 *
 * The `automationProviders.nextcloud` credential slot is rebuilt in memory on
 * every automation fire and its `persist` is a no-op, so a uid written back there
 * is discarded — meaning every unattended fire paid an extra OCS round-trip to
 * `/cloud/user` before it could touch WebDAV. A Nextcloud uid does not change
 * for a given Bee Flow user, so caching it here is safe; the TTL only bounds
 * the damage if an account is genuinely re-pointed at a different instance.
 */
const _uidCache = new Map(); // userId -> { uid, expiresAt }
const UID_CACHE_TTL_MS = 60 * 60 * 1000;

function cachedUid(userId) {
    if (!userId) return null;
    const hit = _uidCache.get(userId);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) { _uidCache.delete(userId); return null; }
    return hit.uid;
}

function rememberUid(userId, uid) {
    if (!userId || !uid) return;
    // Bounded: a runaway tenant cannot grow this without limit.
    if (_uidCache.size > 5000) _uidCache.clear();
    _uidCache.set(userId, { uid, expiresAt: Date.now() + UID_CACHE_TTL_MS });
}

/**
 * Resolve the WebDAV uid for the current OAuth session. Uses the cached uid
 * on the credential slot if present (set by the OAuth callback), then the
 * process cache, and only then falls back to a one-shot OCS lookup.
 */
async function resolveUid(session, baseUrl) {
    const creds = getNextcloudCredsRef(session);
    if (creds?.uid) return creds.uid;
    const userId = session?.user?.id || null;
    const cached = cachedUid(userId);
    if (cached) {
        creds.uid = cached;
        return cached;
    }
    if (!creds?.accessToken) throw new Error('No Nextcloud access token available');

    const res = await nextcloudFetch(`${baseUrl}/ocs/v2.php/cloud/user?format=json`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${creds.accessToken}`,
            'OCS-APIRequest': 'true',
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`Failed to resolve Nextcloud uid (${res.status})`);
    }
    const body = await res.json();
    const uid = body?.ocs?.data?.id;
    if (!uid) throw new Error('Nextcloud uid not present in OCS response');
    creds.uid = uid;
    creds.persist();
    rememberUid(userId, uid);
    return uid;
}

// Parse Retry-After per RFC 7231: integer seconds, or HTTP-date. Returns ms.
function parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(headerValue);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
    return null;
}

const RETRY_STATUS = new Set([429, 503]);
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
// Ceiling on how long a Retry-After may park a worker. Nextcloud's own
// bruteforce throttle can advertise very long delays, and a misconfigured (or
// hostile) instance answering `Retry-After: 86400` would otherwise pin the
// worker for a day — the request timeout lives inside doFetch and does not
// cover the sleep.
const MAX_BACKOFF_MS = 30_000;

// Wrap a request thunk with retry-on-429/503 + exponential backoff (honours
// Retry-After, clamped). The thunk should perform a single HTTP request and
// return the Response; it's invoked again on each retry.
//
// Bodies must be replayable. A stream body is consumed by the first attempt,
// so retrying would silently send an empty payload — return the throttle
// response instead and let the caller surface it.
async function retryOnThrottle(initialResponse, doFetch, options = {}) {
    if (isUnreplayableBody(options.body)) return initialResponse;
    let response = initialResponse;
    let attempt = 0;
    while (RETRY_STATUS.has(response.status) && attempt < MAX_RETRIES) {
        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        const backoffMs = Math.min(
            retryAfterMs ?? (BASE_BACKOFF_MS * Math.pow(2, attempt)),
            MAX_BACKOFF_MS,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        attempt += 1;
        response = await doFetch();
    }
    return response;
}

function isUnreplayableBody(body) {
    if (body == null) return false;
    if (typeof body === 'string' || Buffer.isBuffer(body) || ArrayBuffer.isView(body)) return false;
    if (body instanceof ArrayBuffer) return false;
    // ReadableStream, Node stream, FormData with a stream part, …
    return typeof body === 'object';
}

/**
 * Fetch wrapper: injects Bearer auth, retries once on 401 after refreshing,
 * and retries up to MAX_RETRIES times on 429/503 with exponential backoff
 * (honouring Retry-After when present). Returns the raw Response so callers
 * can branch on status / read body shape.
 */
async function ncFetch(url, session, options = {}) {
    const creds = getNextcloudCredsRef(session);
    if (!creds) {
        throw new Error('NOT_CONNECTED');
    }

    const doFetch = async (token) => {
        const headers = {
            'Authorization': `Bearer ${token}`,
            ...(options.headers || {}),
        };
        return nextcloudFetch(url, {
            ...options,
            headers,
            signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    };

    let response = await doFetch(creds.accessToken);

    if (response.status === 401) {
        try {
            const newToken = await refreshAccessToken(session);
            response = await doFetch(newToken);
        } catch (refreshErr) {
            log.error('[Nextcloud] Token refresh failed:', refreshErr.message);
            // Surface the original 401 so callers can render their own error.
            return response;
        }
    }

    // Re-read creds.accessToken on each retry — refresh may have rotated it.
    return retryOnThrottle(response, () => doFetch(creds.accessToken), options);
}

/**
 * Resolve the auth context shared by every Nextcloud tool module (files,
 * calendar, contacts, Deck, notifications). Returns a pre-bound `fetch` so
 * callers don't have to know about Bearer-vs-Basic — they just call it.
 *
 *   { mode: 'bearer', baseUrl, uid, fetch, authError }
 *   { mode: 'basic',  baseUrl, uid, username, password, fetch, authError }
 *
 * In both modes `uid` is the Nextcloud user identifier needed to construct
 * /remote.php/dav/{calendars,addressbooks,files}/<uid>/... paths.
 */
/**
 * Resolve the caller's Nextcloud instance binding — {orgId, ncUid} — or null.
 *
 * The binding is an ORG-LEVEL fact (see auth/ncAudience.js: an NC org admin
 * who logs in at beeflow.nl in a normal browser is still an NC customer), so
 * it must be derivable from the DB row alone. Session extras written by
 * connectorJwt (connectorOrgId/connectorNcUid) are only the fast path: the
 * standalone cookie login (auth/loginRoutes.js), the OPAQUE login
 * (auth/opaqueRoutes.js) and the x-session-token bridge all build sessions
 * without them, and those are exactly the sessions org admins use.
 *
 * ncUid is read snake_case FIRST: userStore.getUser returns the raw row and
 * the column is nc_uid. `ncUid` has been the recurring dead-fallback bug in
 * this codebase (routes/automation/crud.js:802, NC-AUTOMATIONS WS-8B/WS-11);
 * both spellings are read so neither storage shape can regress silently.
 *
 * Security: this widens nothing. The uid comes only from the caller's own
 * session/DB row (never request headers), and three independent org-level
 * facts still gate connector auth — isNcOrg (nc_instance_id or write-once
 * registration_source), org.connector_callback_url, and the org tenant key.
 */
async function resolveNcBinding(session, userId) {
    let orgId = session?.connectorOrgId || session?.user?.organizationId || null;
    let ncUid = session?.connectorNcUid || session?.user?.nc_uid || session?.user?.ncUid || null;
    if (!orgId || !ncUid) {
        const id = userId || session?.user?.id;
        if (!id) return null;
        try {
            const userStore = require('../stores/userStore');
            const row = await userStore.getUser(id);
            orgId = orgId || row?.organizationId || row?.organization_id || null;
            ncUid = ncUid || row?.nc_uid || row?.ncUid || null;
        } catch (_) {
            return null;
        }
    }
    if (!orgId || !ncUid) return null;
    try {
        const { isNcOrg } = require('../auth/ncAudience');
        if (!(await isNcOrg(orgId))) return null;
    } catch (_) {
        return null;
    }
    return { orgId, ncUid };
}

// Connector-proxied auth: the user is bound to a Nextcloud instance (via the
// ExApp connector session, or via their DB row for standalone logins), so we
// may have zero credentials — route every NC call through the connector's
// /nc/* reverse proxy. The connector signs with AppAPI shared-secret +
// impersonates the user — no credentials ever touch this process.
async function resolveConnectorAuth(session, userId) {
    const binding = await resolveNcBinding(session, userId);
    if (!binding) return null;
    const { orgId, ncUid } = binding;

    const userStore = require('../stores/userStore');
    const org = await userStore.getOrganization(orgId);
    const callbackUrl = org?.connector_callback_url;
    if (!callbackUrl) return null;

    const tenantKey = await configStore.getSecret(`connector_tenant_key_${orgId}`);
    if (!tenantKey) return null;

    const baseUrl = `${callbackUrl.replace(/\/+$/, '')}/nc`;
    const connectorFetch = async (url, options = {}) => {
        // url may be absolute (full <baseUrl>/...) or a path. Normalise to
        // the path-and-query the connector will see, since that's what we
        // sign over.
        let pathOnly;
        if (url.startsWith(baseUrl)) {
            pathOnly = '/nc' + url.slice(baseUrl.length);
        } else if (url.startsWith('/nc')) {
            pathOnly = url;
        } else {
            pathOnly = url; // best-effort: caller already passed correct path
        }
        const method = (options.method || 'GET').toUpperCase();
        // Nextcloud's AppAPI proxy (which fronts the connector's /nc/* route for
        // SaaS→NC callbacks) only reliably forwards GET and POST raw. Every other
        // verb — the WebDAV methods (PROPFIND/REPORT/MKCOL/MOVE/COPY/…) AND the
        // write verbs (PUT/DELETE/PATCH) — is rejected (PROPFIND/REPORT surface as
        // 405; PUT/DELETE/PATCH as 401), so reads work but writes fail. Tunnel
        // everything except GET/POST over POST + X-HTTP-Method-Override; the
        // connector restores the real method before it reaches Nextcloud (where
        // DAV/writes work fine). The HMAC is signed over the REAL method so the
        // connector can verify it after un-tunnelling.
        const RAW_METHODS = new Set(['GET', 'POST']);
        const needsTunnel = !RAW_METHODS.has(method);
        const wireMethod = needsTunnel ? 'POST' : method;
        // Signing (decoded path, real method, body hash) lives in
        // integrations/ncSigning.js — one implementation shared with the
        // service-level signer in services/ncUserGroupSync.js, so the v2
        // wire format cannot drift between them.
        //
        // Sign per attempt, not once up front: a throttle retry can sleep
        // long enough (Retry-After, capped at MAX_BACKOFF_MS) that a
        // timestamp minted before the first attempt would fall outside the
        // connector's skew window by the time the retry lands.
        const signedHeaders = () => ({
            ...(options.headers || {}),
            ...signedConnectorHeaders({ tenantKey, method, path: pathOnly, ncUid, body: options.body }),
            ...(needsTunnel ? { 'X-HTTP-Method-Override': method } : {}),
        });
        // Plain fetch here, unlike the OAuth/Basic paths: this targets the
        // org's connector callback URL (admin-configured, not user-supplied),
        // carries no credentials — the connector signs with the tenant key —
        // and self-host connectors legitimately live on a private network.
        const doOnce = () => fetch(url, {
            ...options,
            method: wireMethod,
            headers: signedHeaders(),
            signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const first = await doOnce();
        return retryOnThrottle(first, doOnce, options);
    };
    return {
        mode: 'connector',
        baseUrl,
        // The connector `baseUrl` is the ExApp proxy: fine for DAV/OCS calls,
        // useless as a link a person opens. The org's public Nextcloud URL is
        // what a `/f/<fileId>` deep link needs (same source the spreadsheet
        // mirror uses for its web links).
        publicBaseUrl: String(org?.nc_base_url || org?.ncBaseUrl || '').replace(/\/+$/, '') || null,
        uid: ncUid,
        session,
        fetch: connectorFetch,
        authError: 'Bee Flow connector could not reach Nextcloud — please ensure the ExApp is enabled.',
    };
}

/**
 * Cheap, network-free check for whether this user has *any* Nextcloud
 * connection (connector / OAuth / saved app-password). Mirrors the three
 * branches of resolveAuth but skips the network-y uid resolution, so it's safe
 * to call on a settings page load to decide whether to show NC-specific UI.
 */
async function isConnected(session, userId) {
    if (session?.user?.provider === 'nextcloud_connector' || session?.connectorOrgId) return true;
    if (isNextcloudOAuthSession(session)) return true;
    try {
        const userStore = require('../stores/userStore');
        const creds = await userStore.getAppPassword(userId);
        if (creds && creds.username && creds.password) return true;
    } catch (_) {
        // fall through to the binding check
    }
    // DB-backed binding: an NC-org user in a standalone/bridged session is
    // still connected (the connector routes their calls) even though the
    // session carries none of the connector extras.
    try {
        return !!(await resolveNcBinding(session, userId));
    } catch (_) {
        return false;
    }
}

/**
 * True when this session arrived through the Nextcloud ExApp connector.
 *
 * Connector calls authenticate with AppAPI shared-secret impersonation rather
 * than a Bearer session, so Nextcloud's CORS middleware — the reason Deck and
 * Notes normally demand HTTP Basic — does not apply to them.
 */
function isConnectorSession(session) {
    return !!(session?.user?.provider === 'nextcloud_connector' || session?.connectorOrgId);
}

async function resolveAuth(session, userId) {
    // Connector path takes priority: if the user came in via the Nextcloud
    // ExApp connector, we have an instance binding and zero credentials —
    // routing through /nc/* is the only way to reach NC.
    if (isConnectorSession(session)) {
        const connector = await resolveConnectorAuth(session, userId);
        if (connector) return connector;
        // fall through to legacy paths if connector binding incomplete
    }

    if (isNextcloudOAuthSession(session)) {
        // OAuth always targets the org-configured instance the user logged into.
        const baseUrl = await getBaseUrl();
        const uid = await resolveUid(session, baseUrl);
        return {
            mode: 'bearer',
            baseUrl,
            uid,
            session,
            fetch: (url, options) => ncFetch(url, session, options),
            authError: 'Nextcloud session expired — please log in again.',
        };
    }

    // App-password fallback. Lazy-required so we don't pull userStore into
    // every importer of this module.
    const userStore = require('../stores/userStore');
    const creds = await userStore.getAppPassword(userId);
    if (!creds || !creds.username || !creds.password) {
        // Last resort before failing: an NC-org user whose binding lives only
        // on the DB row (standalone/bridged session — the org-admin case).
        // Strictly error→success: this branch is only reached where the call
        // previously threw, so working OAuth/app-password paths are untouched.
        const connector = await resolveConnectorAuth(session, userId);
        if (connector) return connector;
        throw new Error('Nextcloud not connected. Log in via Nextcloud OAuth, or add your username and app password in Settings → Connections.');
    }
    // Prefer the URL the user saved with their app password; org default otherwise.
    const baseUrl = await getBaseUrl(creds.url);
    const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    // nextcloudFetch, not fetch: this request carries the user's Basic
    // credentials to a host the user chose, so the target is re-validated on
    // every call (and resolved through the SSRF-safe dispatcher by default).
    const basicFetch = async (url, options = {}) => {
        const doOnce = () => nextcloudFetch(url, {
            ...options,
            headers: { 'Authorization': auth, ...(options.headers || {}) },
            signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const first = await doOnce();
        return retryOnThrottle(first, doOnce, options);
    };
    return {
        mode: 'basic',
        baseUrl,
        uid: creds.username,
        username: creds.username,
        password: creds.password,
        fetch: basicFetch,
        authError: 'Nextcloud rejected credentials. Re-save your app password in Settings → Integrations.',
    };
}

/**
 * Build a Basic-Auth context, regardless of OAuth session state. Required for
 * Nextcloud apps whose API routes carry the `#[CORS]` attribute (Notes, Deck,
 * possibly others) — Nextcloud's CORS middleware logs the Bearer session out
 * and demands HTTP Basic credentials, so OAuth alone returns 401.
 *
 * Returns null when the user has no saved app password — caller should surface
 * a CORS-specific error message rather than the generic session-expired one.
 */
async function resolveBasicAuthOrNull(userId) {
    const userStore = require('../stores/userStore');
    const creds = await userStore.getAppPassword(userId);
    if (!creds || !creds.username || !creds.password) return null;
    const baseUrl = await getBaseUrl(creds.url);
    const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    // nextcloudFetch, not fetch: this request carries the user's Basic
    // credentials to a host the user chose, so the target is re-validated on
    // every call (and resolved through the SSRF-safe dispatcher by default).
    const basicFetch = async (url, options = {}) => {
        const doOnce = () => nextcloudFetch(url, {
            ...options,
            headers: { 'Authorization': auth, ...(options.headers || {}) },
            signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const first = await doOnce();
        return retryOnThrottle(first, doOnce, options);
    };
    return {
        mode: 'basic',
        baseUrl,
        uid: creds.username,
        username: creds.username,
        password: creds.password,
        fetch: basicFetch,
        authError: 'Nextcloud rejected credentials. Re-save your app password in Settings → Integrations.',
    };
}

const CORS_AUTH_ERROR = 'Nextcloud\'s Notes/Deck APIs use CORS protection that requires HTTP Basic auth — your OAuth login alone won\'t work for these. Please add a Nextcloud app password in Settings → Integrations.';

/**
 * Stream a binary file from Nextcloud Files (WebDAV) to disk.
 *
 * Used for audio/video imports where loading the whole file into memory
 * would be wasteful — meeting recordings can easily exceed 100 MB.
 *
 * @param {object} session  Express session (used to resolve auth).
 * @param {string} userId   For app-password fallback.
 * @param {string} ncPath   Path within the user's Files root, e.g. "/Recordings/2026-05-08.mp3".
 * @param {string} destPath Local filesystem path to write to.
 * @returns {Promise<{ size, contentType }>}
 */
async function downloadBinary(session, userId, ncPath, destPath) {
    const ctx = await resolveAuth(session, userId);
    const root = webdavRoot(ctx.baseUrl, ctx.uid);
    // Build the WebDAV URL — encode each segment so spaces and unicode
    // characters survive the round-trip.
    const segments = String(ncPath || '').split('/').filter(Boolean).map(encodeURIComponent);
    const url = `${root}/${segments.join('/')}`;

    const res = await ctx.fetch(url, {
        method: 'GET',
        // Allow larger downloads; the connection itself stays bounded by ncFetch's timeout.
        signal: AbortSignal.timeout(15 * 60 * 1000),
    });

    if (res.status === 404) throw new Error(`File not found: ${ncPath}`);
    if (res.status === 401) throw new Error(ctx.authError || 'Nextcloud auth failed');
    if (!res.ok) throw new Error(`Nextcloud download failed (${res.status})`);

    const fs = require('fs');
    const { Readable } = require('stream');
    const { pipeline } = require('stream/promises');

    // Node's fetch returns a Web ReadableStream — convert to a Node stream
    // so .pipe() works and we don't keep the entire body in memory.
    const nodeStream = res.body && typeof Readable.fromWeb === 'function'
        ? Readable.fromWeb(res.body)
        : res.body;
    const out = fs.createWriteStream(destPath);
    await pipeline(nodeStream, out);

    const stat = fs.statSync(destPath);
    return {
        size: stat.size,
        contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
}

module.exports = {
    isNextcloudOAuthSession,
    isConnectorSession,
    isConnected,
    resolveNcBinding,
    getBaseUrl,
    webdavRoot,
    refreshAccessToken,
    resolveUid,
    resolveAuth,
    resolveBasicAuthOrNull,
    ncFetch,
    downloadBinary,
    REQUEST_TIMEOUT_MS,
    CORS_AUTH_ERROR,
};
