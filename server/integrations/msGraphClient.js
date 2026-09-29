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

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

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

    // First attempt
    let response = await doFetch(session.accessToken);

    // Retry with refreshed token on 401
    if (response.status === 401) {
        try {
            const newToken = await refreshAccessToken(session);
            response = await doFetch(newToken);
        } catch (refreshErr) {
            log.error('[MSGraph] Token refresh failed:', refreshErr.message);
            throw new Error('NOT_CONNECTED');
        }
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

/**
 * Check if the current session is connected to Microsoft.
 */
function isMicrosoftConnected(session) {
    return !!(session?.accessToken && session?.oauthProvider === 'microsoft');
}

module.exports = {
    graphFetch,
    graphRequest,
    refreshAccessToken,
    isMicrosoftConnected,
    GRAPH_BASE,
};
