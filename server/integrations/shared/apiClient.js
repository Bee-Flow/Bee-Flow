/**
 * jsonApiRequest — the hardened choke point for outbound calls to
 * user/org-configured third-party APIs (H10).
 *
 * Fixes a class of problems the ad-hoc per-tool fetch calls had:
 *   - SSRF: a user/org can set a tool's "base URL" (YouTrack, n8n, …) to an
 *     internal address (169.254.169.254, 127.0.0.1, exotic-IPv4 spellings) and
 *     use the agent as a proxy. Every request runs through the sync
 *     utils/isPrivateTarget pre-filter first, unless the caller opts out with
 *     `allowPrivate` (for self-hosted internal services like a private n8n).
 *   - Hang → agent-loop DoS: a third-party API that never responds blocked a
 *     tool call indefinitely. Every request gets a mandatory AbortSignal
 *     timeout.
 *   - Credential/URL leakage into the model: error handlers used to throw the
 *     full response body (and sometimes the URL) into LLM context. Here the
 *     error is message-only and truncated.
 *
 * Connection reuse is handled by undici's global dispatcher (keep-alive by
 * default), so no per-request agent is created.
 *
 * @param {string} url absolute URL
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {Record<string,string>} [opts.headers]
 * @param {any} [opts.body] object (JSON-encoded) or string
 * @param {number} [opts.timeoutMs=30000]
 * @param {string} [opts.errorPrefix='API'] prefix for thrown error messages
 * @param {number} [opts.maxErrorChars=500] error-body truncation length
 * @param {boolean} [opts.allowPrivate=false] skip the SSRF pre-filter (self-host internal services)
 * @returns {Promise<any>} parsed JSON, raw text, or null (empty body)
 */
const { isPrivateTarget } = require('../../utils/isPrivateTarget');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_ERROR_CHARS = 500;

function _truncate(s, n) {
    s = String(s);
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function jsonApiRequest(url, opts = {}) {
    const {
        method = 'GET',
        headers = {},
        body,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        errorPrefix = 'API',
        maxErrorChars = DEFAULT_MAX_ERROR_CHARS,
        allowPrivate = false,
    } = opts;

    if (!allowPrivate && isPrivateTarget(url)) {
        const err = new Error(`${errorPrefix}: request to a private or blocked address was refused`);
        err.code = 'EPRIVATETARGET';
        throw err;
    }

    const reqHeaders = { ...headers };
    let payload;
    if (body !== undefined && body !== null) {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
        const hasCT = Object.keys(reqHeaders).some((h) => h.toLowerCase() === 'content-type');
        if (!hasCT) reqHeaders['Content-Type'] = 'application/json';
    }

    let resp;
    try {
        resp = await fetch(url, {
            method,
            headers: reqHeaders,
            body: payload,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
            const err = new Error(`${errorPrefix}: request timed out after ${timeoutMs}ms`);
            err.code = 'ETIMEDOUT';
            throw err;
        }
        // Never surface the URL or lower-level detail (may contain credentials).
        const err = new Error(`${errorPrefix}: request failed`);
        err.code = 'EREQUEST';
        throw err;
    }

    const text = await resp.text();
    if (!resp.ok) {
        const err = new Error(`${errorPrefix}: HTTP ${resp.status} ${_truncate(text, maxErrorChars)}`);
        err.status = resp.status;
        throw err;
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
}

module.exports = { jsonApiRequest };
