/**
 * Google API Client — Shared helper for Google integrations
 *
 * Provides an authenticated fetch wrapper for Google REST APIs (Drive,
 * Calendar, Gmail, …). Pattern mirrors `msGraphClient.js`:
 *   - Reads access token from session
 *   - Auto-refreshes once via refresh_token on 401 / token_expired
 *   - Re-issues the request transparently
 *
 * Without this, long-running automations that touch Google APIs silently
 * stop working ~1 hour after each user re-auth.
 */

const { loadConfig } = require('../auth/permissions');
const { google } = require('googleapis');
const log = require('../telemetry/log');
const { parseRetryAfter, backoffDelay, sleep } = require('../core/http/retryAfter');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * Exchange the session's refresh_token for a fresh access_token. Updates the
 * session in place and persists via session.save() so the new token survives
 * across requests. Throws on missing refresh token or non-2xx from Google.
 */
async function refreshAccessToken(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const refreshToken = session?.refreshToken;
    if (!refreshToken) {
        throw new Error('No refresh token available — user must re-authenticate with Google');
    }

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: providerConfig.clientId,
            client_secret: providerConfig.clientSecret,
        }).toString(),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        log.error('[Google] Token refresh failed:', errorText);
        throw new Error('Google token refresh failed — user must re-authenticate');
    }

    const tokenData = await response.json();

    if (tokenData.access_token) {
        session.accessToken = tokenData.access_token;
    }
    // Google only rotates refresh tokens on demand (?prompt=consent); keep the
    // existing one when the response omits it.
    if (tokenData.refresh_token) {
        session.refreshToken = tokenData.refresh_token;
    }
    session.save?.();

    return tokenData.access_token;
}

/**
 * Authenticated fetch against a Google REST endpoint. Retries once with a
 * refreshed token on 401. Mirrors `msGraphClient.graphFetch`.
 */
async function googleFetch(url, session, options = {}) {
    if (!session?.accessToken) {
        throw new Error('NOT_CONNECTED');
    }

    const doFetch = async (token) => {
        const headers = {
            'Authorization': `Bearer ${token}`,
            ...(options.headers || {}),
        };
        if (options.body && !headers['Content-Type'] && typeof options.body === 'string') {
            headers['Content-Type'] = 'application/json';
        }
        return fetch(url, { ...options, headers });
    };

    let response = await doFetch(session.accessToken);

    if (response.status === 401) {
        try {
            const newToken = await refreshAccessToken(session);
            response = await doFetch(newToken);
        } catch (refreshErr) {
            log.error('[Google] Token refresh failed:', refreshErr.message);
            throw new Error('NOT_CONNECTED');
        }
    }

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        let errorMsg = `Google API error: ${response.status}`;
        try {
            const parsed = JSON.parse(errorBody);
            errorMsg = parsed.error?.message || parsed.error_description || errorMsg;
        } catch (_) { /* non-JSON */ }
        throw new Error(errorMsg);
    }

    if (response.status === 202 || response.status === 204) {
        return { success: true };
    }

    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
        return await response.json();
    }
    return await response.text();
}

/**
 * Revoke a Google access/refresh token at Google's revoke endpoint.
 * Best-effort: a non-2xx response is logged but not thrown, since the
 * caller usually wants to delete local state regardless.
 */
async function revokeToken(token) {
    if (!token) return false;
    try {
        const r = await fetch(GOOGLE_REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }).toString(),
        });
        return r.ok;
    } catch (e) {
        log.warn('[Google] revoke failed:', e.message);
        return false;
    }
}

function isGoogleConnected(session) {
    return !!(session?.accessToken && session?.oauthProvider === 'google');
}

// ── Throttling ─────────────────────────────────────────────────────────
//
// googleapis already retries GETs on 429 and 5xx (gaxios: three tries, 0.1 s,
// 0.5 s, 1.5 s apart, Retry-After ignored). Two gaps that matter once an
// automation works through a few hundred emails: Google also signals its
// per-user and per-project rate limits as 403 `userRateLimitExceeded` /
// `rateLimitExceeded`, which was not retried at all (worse: the OAuth client
// took the 403 for an auth error and refreshed the token for nothing), and the
// waits were too short to let a per-minute quota recover. Google's advice is
// exponential backoff of about 2^n seconds plus up to a second of jitter, and
// honouring Retry-After when given
// (https://developers.google.com/workspace/gmail/api/guides/handle-errors).
//
// Only methods that are safe to send again are retried (gaxios' own list), so
// a POST such as messages.send or batchModify is never sent twice.

const RETRY_METHODS = new Set(['GET', 'HEAD', 'PUT', 'OPTIONS', 'DELETE']);
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const GOOGLE_MAX_RETRIES = 3;
const GOOGLE_NO_RESPONSE_RETRIES = 2;

/** A 403 that is Google saying "slow down", not "you may not". */
function isRateLimitError(data) {
    const error = data && typeof data === 'object' ? data.error : null;
    if (!error || typeof error !== 'object') return false;
    if (error.status === 'RESOURCE_EXHAUSTED') return true;
    return Array.isArray(error.errors) && error.errors.some(e => RATE_LIMIT_REASONS.has(e?.reason));
}

/** gaxios `shouldRetry`: the default rules, plus rate-limit 403s. */
function shouldRetryGoogleRequest(err) {
    const config = err?.config || {};
    if (err?.code === 'AbortError' || (config.signal?.aborted && err?.code !== 'TimeoutError')) return false;
    const method = String(config.method || 'GET').toUpperCase();
    if (!RETRY_METHODS.has(method)) return false;
    const attempt = config.retryConfig?.currentRetryAttempt || 0;
    const status = err?.response?.status;
    if (!status) return attempt < GOOGLE_NO_RESPONSE_RETRIES;
    if (attempt >= GOOGLE_MAX_RETRIES) return false;
    if (status === 403) return isRateLimitError(err.response.data);
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** gaxios `retryBackoff`: Retry-After when Google names one, else ~2^n s with jitter. */
function googleRetryBackoff(err) {
    // gaxios has already counted this retry, so the first one arrives as 1.
    const attempt = Math.max(0, (err?.config?.retryConfig?.currentRetryAttempt || 1) - 1);
    const header = err?.response?.headers?.get?.('retry-after') ?? err?.response?.headers?.['retry-after'];
    return sleep(backoffDelay(attempt, {
        retryAfterMs: parseRetryAfter(header),
        baseMs: 1000,
        jitterMs: 1000,
        maxMs: 32_000,
    }), err?.config?.signal || null);
}

const GOOGLE_RETRY_CONFIG = Object.freeze({
    retry: GOOGLE_MAX_RETRIES,
    shouldRetry: shouldRetryGoogleRequest,
    retryBackoff: googleRetryBackoff,
});

/**
 * Create an authenticated googleapis SDK client from a live session (M3).
 *
 * The single canonical builder the ~10 per-API copies (gmail/calendar/drive/
 * docs/sheets/slides/contacts/keep + the routes/integrations builders) collapse
 * to: loadConfig → provider creds → OAuth2 client → setCredentials → an
 * on('tokens') write-back → google[api]({version, auth}). Callers keep their
 * per-API not-connected error string and their return shape.
 *
 * Write-back strategy is a parameter — session-based callers get the default
 * `session.save?.()`; store/vault-backed callers pass `onSaved(session)` (this
 * is what will fix the "automations die ~1h after auth" drift for triggerBus,
 * whose vault sessions have no .save()).
 *
 * @param {Object}   session                  Live session (mutated on token refresh).
 * @param {Object}   opts
 * @param {string}   opts.api                 google API name, e.g. 'gmail', 'calendar', 'drive'.
 * @param {string}   opts.version             API version, e.g. 'v1', 'v3'.
 * @param {Array}    [opts.extraApis]         [{api, version}] extra clients on the SAME OAuth2 (docs/slides/sheets).
 * @param {boolean}  [opts.exposeOAuth2]      also return the oauth2Client (docs/slides/sheets).
 * @param {Function} [opts.onSaved]           write-back override; default session.save?.().
 * @param {string}   [opts.notConnectedError] error message when the session has no accessToken.
 * @returns {Promise<Object>} google[api] client, or {[api], ...extraApis, oauth2Client}.
 */
async function createGoogleApiClient(session, { api, version, extraApis = [], exposeOAuth2 = false, onSaved, notConnectedError, notConfiguredError } = {}) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};
    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error(notConfiguredError || 'Google OAuth not configured');
    }
    if (!session?.accessToken) {
        throw new Error(notConnectedError || 'Not connected to Google — user must log in with Google');
    }

    const oauth2Client = new google.auth.OAuth2(providerConfig.clientId, providerConfig.clientSecret);
    oauth2Client.setCredentials({
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
    });
    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) session.accessToken = tokens.access_token;
        if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
        if (onSaved) onSaved(session);
        else session.save?.();
    });

    // gaxios mutates the retry config it is given, so every client gets its own copy.
    const primary = google[api]({ version, auth: oauth2Client, retryConfig: { ...GOOGLE_RETRY_CONFIG } });
    if (extraApis.length === 0 && !exposeOAuth2) return primary;

    const result = { [api]: primary };
    for (const extra of extraApis) {
        result[extra.api] = google[extra.api]({ version: extra.version, auth: oauth2Client, retryConfig: { ...GOOGLE_RETRY_CONFIG } });
    }
    if (exposeOAuth2) result.oauth2Client = oauth2Client;
    return result;
}

module.exports = {
    googleFetch,
    createGoogleApiClient,
    GOOGLE_RETRY_CONFIG,
    shouldRetryGoogleRequest,
    isRateLimitError,
    refreshAccessToken,
    revokeToken,
    isGoogleConnected,
    GOOGLE_TOKEN_URL,
    GOOGLE_REVOKE_URL,
};
