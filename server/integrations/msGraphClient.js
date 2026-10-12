/**
 * Microsoft Graph API Client — Shared helper for Microsoft integrations
 * 
 * Provides an authenticated HTTP client for Microsoft Graph API v1.0.
 * Uses the OAuth2 access token from the session, with automatic
 * token refresh using the refresh token when available.
 * 
 * Pattern mirrors the Google integrations' `createXxxClient()` approach,
 * but uses fetch + Bearer token instead of the Google SDK.
 */

const { loadConfig, microsoftRefreshScope } = require('../auth/permissions');
const log = require('../telemetry/log');
const { parseRetryAfter, backoffDelay, sleep, isReplayableBody } = require('../core/http/retryAfter');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── Throttling ─────────────────────────────────────────────────────────
//
// Graph throttles per app and per mailbox (Outlook: 10,000 requests per 10
// minutes, 4 at once) and answers 429 with a Retry-After in seconds; Graph's
// guidance is to wait exactly that long and send again, and to back off
// exponentially when there is no header
// (https://learn.microsoft.com/en-us/graph/throttling). A 429 was never
// processed, so sending it again is safe for every method, a sendMail too.
// A 503 or 504 may have been: those are only sent again for GET and HEAD,
// never for a POST that sends mail, books a meeting or deletes a row.
//
// How long to wait is bounded by who may still be waiting. A read waits at
// most 30 seconds in all. A write waits at most once, and only when Graph asks
// for 5 seconds or less: a person who clicked Send and saw nothing for a
// minute clicks again, and the first mail, still waiting here, would then go
// out as a second one.
const GRAPH_MAX_RETRIES = 3;
const GRAPH_MAX_WAIT_MS = 30_000;
const GRAPH_WRITE_MAX_WAIT_MS = 5_000;
const RESENDABLE_ON_5XX = new Set(['GET', 'HEAD']);
let wait = sleep;

/** Test hook: replace the throttling sleep (returns the restore function). */
function _setSleepForTests(fn) {
    const previous = wait;
    wait = fn || sleep;
    return () => { wait = previous; };
}

function isThrottled(status, method) {
    if (status === 429) return true;
    return (status === 503 || status === 504) && RESENDABLE_ON_5XX.has(method);
}

/**
 * Refresh the Microsoft OAuth access token using the refresh token.
 * Returns the new access token (and updates the session).
 */
async function refreshAccessToken(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.microsoft || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Microsoft OAuth not configured');
    }

    const refreshToken = session?.refreshToken;
    if (!refreshToken) {
        throw new Error('No refresh token available — user must re-authenticate with Microsoft');
    }

    const tenantId = providerConfig.tenantId || 'common';
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: providerConfig.clientId,
            client_secret: providerConfig.clientSecret,
            // What was granted, not what we happen to know about — see
            // microsoftRefreshScope in auth/permissions.js.
            scope: microsoftRefreshScope(session?.oauthScope),
        }).toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        log.error('[MSGraph] Token refresh failed:', errorText);
        throw new Error('Microsoft token refresh failed — user must re-authenticate');
    }

    const tokenData = await response.json();

    // Update session tokens
    if (tokenData.access_token) {
        session.accessToken = tokenData.access_token;
    }
    if (tokenData.refresh_token) {
        session.refreshToken = tokenData.refresh_token;
    }
    session.save?.();

    return tokenData.access_token;
}

/**
 * The raw request: bearer + ONE refresh-and-retry on 401, nothing else.
 * Returns the fetch Response untouched — status, headers and body are the
 * caller's to read. This is what a caller needs when the HTTP status IS the
 * answer (412 = the file moved under an If-Match, 423 = locked, 404 = gone),
 * or when the body is bytes rather than JSON (PUT …/content with a Buffer,
 * the workbook PATCH calls that carry a `workbook-session-id`). graphFetch
 * below is this plus JSON defaults and the historical "throw a message"
 * error shape its callers pin.
 *
 * No Content-Type is set here: a Buffer body without one lets Graph type the
 * item by its extension, and a JSON caller sets its own.
 *
 * @param {string} path - API path (e.g. '/me/drive') or an absolute Graph URL
 * @param {Object} session - session-shaped object with accessToken/refreshToken
 * @param {Object} options - fetch options (method, body, headers, signal, …)
 * @returns {Promise<Response>}
 */
async function graphRequest(path, session, options = {}) {
    if (!session?.accessToken) {
        throw new Error('NOT_CONNECTED');
    }

    const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;

    const doFetch = async (token) => {
        const headers = {
            'Authorization': `Bearer ${token}`,
            ...(options.headers || {}),
        };
        return fetch(url, { ...options, headers });
    };

    // One refresh-and-retry on 401 per call, wherever the 401 comes.
    let refreshed = false;
    const refreshAndResend = async () => {
        refreshed = true;
        try {
            const newToken = await refreshAccessToken(session);
            return await doFetch(newToken);
        } catch (refreshErr) {
            log.error('[MSGraph] Token refresh failed:', refreshErr.message);
            throw new Error('NOT_CONNECTED');
        }
    };

    // First attempt
    let response = await doFetch(session.accessToken);
    if (response.status === 401) response = await refreshAndResend();

    // Throttled: wait as long as Graph asks (within the bounds above), then
    // send again. The last answer comes back untouched either way: callers
    // read 412/423/429 off it.
    const method = String(options.method || 'GET').toUpperCase();
    const isRead = RESENDABLE_ON_5XX.has(method);
    let waited = 0;
    for (let attempt = 0; attempt < GRAPH_MAX_RETRIES && isThrottled(response.status, method) && isReplayableBody(options.body); attempt++) {
        const delay = backoffDelay(attempt, { retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')), maxMs: GRAPH_MAX_WAIT_MS });
        if (!isRead && (attempt > 0 || delay > GRAPH_WRITE_MAX_WAIT_MS)) break;
        if (waited + delay > GRAPH_MAX_WAIT_MS) break;
        waited += delay;
        await response.body?.cancel?.().catch(() => {});
        await wait(delay, options.signal || null);
        response = await doFetch(session.accessToken);
        // The token may have run out while we waited.
        if (response.status === 401 && !refreshed) response = await refreshAndResend();
    }

    return response;
}

/**
 * Make an authenticated request to the Microsoft Graph API.
 * Automatically retries once with a refreshed token on 401.
 * 
 * @param {string} path - API path (e.g. '/me/messages')
 * @param {Object} session - Express session with accessToken/refreshToken
 * @param {Object} options - fetch options (method, body, headers, etc.)
 * @returns {Object} Parsed JSON response
 */
async function graphFetch(path, session, options = {}) {
    // JSON by default; a caller's own Content-Type (spread after) still wins,
    // exactly as before graphRequest was split out.
    const response = await graphRequest(path, session, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        let errorMsg = `Microsoft Graph API error: ${response.status}`;
        try {
            const parsed = JSON.parse(errorBody);
            errorMsg = parsed.error?.message || errorMsg;
        } catch (_) {}
        throw new Error(errorMsg);
    }

    // Handle 202 Accepted / 204 No Content (empty body responses)
    // e.g., sendMail returns 202, DELETE returns 204
    if (response.status === 202 || response.status === 204) {
        return { success: true };
    }

    return await response.json();
}

/** Requests per Graph JSON batch (Graph's limit). */
const GRAPH_BATCH_MAX = 20;
/** Sends of one batched GET, the first included. */
const GRAPH_BATCH_ATTEMPTS = 4;
const GRAPH_RELATIVE_URL = /^\/[^\s]*$/;

/**
 * Many Graph GETs in as few requests as possible: JSON batching, 20 per
 * POST /$batch (https://learn.microsoft.com/en-us/graph/json-batching).
 *
 * The batch itself answers 200 even when requests in it were throttled, so
 * every response is judged on its own: a 429 (or a 503/504: these are GETs)
 * goes into the next batch after the longest Retry-After among them;
 * anything else is final. Responses may come back in any order and are
 * matched by id. GETs only: a write in a batch that half-fails cannot be
 * retried safely, and nothing here needs one.
 *
 * Saves round trips, not throttling budget: each request in a batch still
 * counts against the mailbox's limit, and Graph runs at most four of a
 * mailbox's requests at once.
 *
 * @param {Object} session - Microsoft session (refreshed in place on 401)
 * @param {Array<{ id: string, url: string, headers?: Object }>} requests - `url` relative to
 *   the version root, e.g. `/me/messages/<id>?$select=subject`
 * @param {{ signal?: AbortSignal | null }} [opts]
 * @returns {Promise<Map<string, { status: number, headers: Object, body: any }>>} one entry per
 *   request id; a request Graph never answered has status 0
 */
async function graphBatch(session, requests, { signal = null } = {}) {
    const seen = new Set();
    for (const r of requests) {
        if (!r || typeof r.id !== 'string' || !r.id || seen.has(r.id)) throw new Error('graphBatch: every request needs its own id');
        seen.add(r.id);
        if (typeof r.url !== 'string' || !GRAPH_RELATIVE_URL.test(r.url)) throw new Error(`graphBatch: invalid url for ${r.id}`);
    }
    const results = new Map();
    for (let i = 0; i < requests.length; i += GRAPH_BATCH_MAX) {
        let pending = requests.slice(i, i + GRAPH_BATCH_MAX);
        for (let attempt = 0; pending.length > 0; attempt++) {
            const answer = await graphFetch('/$batch', session, {
                method: 'POST',
                body: JSON.stringify({
                    requests: pending.map(r => ({ id: r.id, method: 'GET', url: r.url, ...(r.headers ? { headers: r.headers } : {}) })),
                }),
                ...(signal ? { signal } : {}),
            });
            const byId = new Map((answer?.responses || []).map(res => [String(res.id), res]));
            const again = [];
            let retryAfterMs = null;
            for (const r of pending) {
                const res = byId.get(r.id);
                const headers = Object.fromEntries(Object.entries(res?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
                if ((!res || isThrottled(res.status, 'GET')) && attempt + 1 < GRAPH_BATCH_ATTEMPTS) {
                    again.push(r);
                    const ms = parseRetryAfter(headers['retry-after']);
                    if (ms !== null) retryAfterMs = Math.max(retryAfterMs ?? 0, ms);
                    continue;
                }
                results.set(r.id, res ? { status: res.status, headers, body: res.body } : { status: 0, headers: {}, body: null });
            }
            if (again.length === 0) break;
            await wait(backoffDelay(attempt, { retryAfterMs, maxMs: GRAPH_MAX_WAIT_MS }), signal);
            if (signal?.aborted) throw new Error('Run cancelled');
            pending = again;
        }
    }
    return results;
}

/**
 * Check if the current session is connected to Microsoft.
 */
function isMicrosoftConnected(session) {
    return !!(session?.accessToken && session?.oauthProvider === 'microsoft');
}

module.exports = {
    graphFetch,
    graphRequest,
    graphBatch,
    GRAPH_BATCH_MAX,
    _setSleepForTests,
    refreshAccessToken,
    isMicrosoftConnected,
    GRAPH_BASE,
};
