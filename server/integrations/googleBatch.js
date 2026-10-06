// @typecheck
/**
 * Google API batch requests: many API calls in ONE HTTP request.
 *
 * Google's APIs accept up to 100 calls in a single `multipart/mixed` POST to an
 * API-specific batch endpoint (Gmail: https://gmail.googleapis.com/batch/gmail/v1,
 * https://developers.google.com/workspace/gmail/api/guides/batch). Each part is
 * a plain HTTP request; the answer is a multipart body with one HTTP response
 * per part, matched by Content-ID. The `googleapis` client has no batch support,
 * so this speaks the wire format over fetch.
 *
 * What it saves is round trips, not quota: every part still counts as its own
 * call against the per-user limit. Gmail advises at most 50 parts per batch
 * ("larger batch sizes are likely to trigger rate limiting"), and one batch at
 * a time per mailbox, which is what this does.
 *
 * Throttling is handled per part. The outer response is 200 even when parts
 * failed, so each part's own status decides: 429, a rate-limit 403
 * (`rateLimitExceeded` / `userRateLimitExceeded`) and 5xx parts are sent again
 * in the next batch after a backoff (Retry-After when a part names one);
 * everything else is final and handed back as is. A 401 refreshes the token
 * once, the same way googleFetch does.
 *
 * Privacy: callers run inside a tool call, so the batch POST is captured by the
 * egress probe of that call like any other request it makes.
 */

const crypto = require('crypto');
const { refreshAccessToken } = require('./googleClient');
const { parseRetryAfter, backoffDelay, sleep } = require('../core/http/retryAfter');

const GMAIL_BATCH_ENDPOINT = 'https://gmail.googleapis.com/batch/gmail/v1';
/** Google's hard limit: 101 parts fail the whole batch with 400. */
const MAX_PARTS = 100;
/** Gmail's advice for one batch. */
const DEFAULT_PARTS = 50;
/** Sends of one part, the first included. */
const MAX_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/** A Content-ID we write ourselves: no spaces, no CR/LF, nothing that ends the header. */
const CONTENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/**
 * A part's request target: a path (and query) on the API host. No whitespace
 * at all, so a value from a run (a message id read off an email) can never end
 * the request line and start a forged header or a second request.
 */
const REQUEST_PATH = /^\/[^\s]*$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const CRLF = '\r\n';

/**
 * @typedef {{ id: string, method?: string, path: string, body?: unknown }} BatchRequest
 * @typedef {{ status: number, headers: Record<string, string>, body: any }} BatchPart
 * @typedef {{ accessToken?: string, refreshToken?: string, save?: () => void }} GoogleSession
 */

/**
 * @param {BatchRequest[]} requests
 * @returns {void}
 */
function validateRequests(requests) {
    if (!Array.isArray(requests)) throw new Error('googleBatch: requests must be an array');
    const seen = new Set();
    for (const r of requests) {
        if (!r || typeof r.id !== 'string' || !CONTENT_ID.test(r.id)) throw new Error(`googleBatch: invalid request id ${JSON.stringify(r?.id)}`);
        if (seen.has(r.id)) throw new Error(`googleBatch: duplicate request id ${r.id}`);
        seen.add(r.id);
        if (typeof r.path !== 'string' || !REQUEST_PATH.test(r.path)) throw new Error(`googleBatch: invalid request path for ${r.id}`);
        if (r.method !== undefined && !METHODS.has(String(r.method).toUpperCase())) throw new Error(`googleBatch: invalid method for ${r.id}`);
    }
}

/**
 * The multipart/mixed body for one batch.
 * @param {BatchRequest[]} requests
 * @param {string} boundary
 * @returns {string}
 */
function buildBatchBody(requests, boundary) {
    let out = '';
    for (const r of requests) {
        out += `--${boundary}${CRLF}`;
        out += `Content-Type: application/http${CRLF}`;
        out += `Content-ID: <${r.id}>${CRLF}${CRLF}`;
        out += `${String(r.method || 'GET').toUpperCase()} ${r.path}${CRLF}`;
        if (r.body !== undefined) {
            out += `Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}`;
            out += JSON.stringify(r.body);
        }
        out += `${CRLF}${CRLF}`;
    }
    return `${out}--${boundary}--${CRLF}`;
}

/**
 * @param {string} block
 * @returns {Record<string, string>}
 */
function parseHeaderBlock(block) {
    /** @type {Record<string, string>} */
    const headers = {};
    for (const line of block.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return headers;
}

/**
 * One part of a batch answer: its MIME headers, then the embedded HTTP
 * response (status line, headers, body).
 * @param {string} chunk
 * @returns {{ contentId: string, part: BatchPart }}
 */
function parsePart(chunk) {
    const text = chunk.replace(/^\r?\n/, '');
    const split = text.search(/\r?\n\r?\n/);
    const mime = parseHeaderBlock(split < 0 ? text : text.slice(0, split));
    const http = split < 0 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
    const lineEnd = http.search(/\r?\n/);
    const statusLine = lineEnd < 0 ? http : http.slice(0, lineEnd);
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] || 0);
    const rest = lineEnd < 0 ? '' : http.slice(lineEnd).replace(/^\r?\n/, '');
    const headEnd = rest.search(/\r?\n\r?\n/);
    const headers = parseHeaderBlock(headEnd < 0 ? rest : rest.slice(0, headEnd));
    const bodyText = headEnd < 0 ? '' : rest.slice(headEnd).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
    /** @type {any} */
    let body = bodyText;
    if (bodyText && (headers['content-type'] || '').includes('json')) {
        try { body = JSON.parse(bodyText); } catch { /* keep the text */ }
    }
    // We send `<x>`; Google answers `<response-x>`.
    const contentId = (mime['content-id'] || '').replace(/^<|>$/g, '').replace(/^response-/, '');
    return { contentId, part: { status, headers, body } };
}

/**
 * A batch answer as Content-ID → part. The boundary is the RESPONSE's own
 * (Google never echoes ours), read from its Content-Type.
 * @param {string | null} contentType
 * @param {string} text
 * @returns {Map<string, BatchPart>}
 */
function parseBatchResponse(contentType, text) {
    const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
    if (!m) throw new Error('googleBatch: the answer is not a multipart batch');
    const delimiter = `--${m[1] || m[2]}`;
    /** @type {Map<string, BatchPart>} */
    const parts = new Map();
    for (const chunk of text.split(delimiter).slice(1)) {
        if (chunk.startsWith('--')) break; // the closing delimiter
        const { contentId, part } = parsePart(chunk);
        if (contentId) parts.set(contentId, part);
    }
    return parts;
}

/**
 * A part worth sending again: throttled (429 or a rate-limit 403) or a
 * server error. A plain 403 (no scope, no access) or a 404 is final.
 * @param {BatchPart | undefined} part
 * @returns {boolean}
 */
function isRetryablePart(part) {
    if (!part) return true; // the answer had no part for it
    if (RETRYABLE_STATUS.has(part.status)) return true;
    if (part.status !== 403) return false;
    const error = part.body && typeof part.body === 'object' ? part.body.error : null;
    if (error?.status === 'RESOURCE_EXHAUSTED') return true;
    return Array.isArray(error?.errors) && error.errors.some((/** @type {any} */ e) => RATE_LIMIT_REASONS.has(e?.reason));
}

/**
 * Send many Google API calls as few HTTP requests as possible.
 *
 * @param {GoogleSession} session - live session (mutated on token refresh, like googleFetch)
 * @param {BatchRequest[]} requests - `path` is the path and query on the API host,
 *   e.g. `/gmail/v1/users/me/messages/<id>?format=full`
 * @param {object} [opts]
 * @param {string} [opts.endpoint] - the API's batch endpoint (Gmail by default)
 * @param {number} [opts.partsPerBatch] - at most 100; 50 by default
 * @param {number} [opts.maxAttempts] - sends per part, the first included
 * @param {AbortSignal | null} [opts.signal] - stops between batches and during a backoff
 * @param {(request: BatchRequest) => Promise<void> | void} [opts.beforePart] - called before
 *   each part is sent (again), e.g. to spend a per-user quota bucket
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number, signal?: AbortSignal | null) => Promise<void>} [opts.sleepImpl]
 * @param {(session: GoogleSession) => Promise<unknown>} [opts.refreshImpl] - token refresh (googleClient's by default)
 * @returns {Promise<Map<string, BatchPart>>} one entry per request id; a part that never
 *   answered has status 0
 */
async function googleBatch(session, requests, opts = {}) {
    const {
        endpoint = GMAIL_BATCH_ENDPOINT,
        partsPerBatch = DEFAULT_PARTS,
        maxAttempts = MAX_ATTEMPTS,
        signal = null,
        beforePart = null,
        fetchImpl = fetch,
        sleepImpl = sleep,
        refreshImpl = refreshAccessToken,
    } = opts;
    if (!session?.accessToken) throw new Error('NOT_CONNECTED');
    validateRequests(requests);
    const size = Math.min(Math.max(1, Math.floor(partsPerBatch) || DEFAULT_PARTS), MAX_PARTS);
    /** @type {Map<string, BatchPart>} */
    const results = new Map();
    const state = { refreshed: false };
    for (let i = 0; i < requests.length; i += size) {
        await settleChunk(requests.slice(i, i + size));
    }
    return results;

    /** @param {BatchRequest[]} chunk */
    async function settleChunk(chunk) {
        let pending = chunk;
        for (let attempt = 0; pending.length > 0; attempt++) {
            if (signal?.aborted) throw new Error('Run cancelled');
            if (beforePart) for (const r of pending) await beforePart(r);
            const parts = await send(pending);
            const again = [];
            let expired = false;
            let throttled = false;
            /** @type {number | null} */
            let retryAfterMs = null;
            for (const r of pending) {
                const part = parts.get(r.id);
                if (part?.status === 401 && !state.refreshed) {
                    again.push(r);
                    expired = true;
                    continue;
                }
                if (isRetryablePart(part) && attempt + 1 < maxAttempts) {
                    again.push(r);
                    throttled = true;
                    const ms = parseRetryAfter(part?.headers?.['retry-after']);
                    if (ms !== null) retryAfterMs = Math.max(retryAfterMs ?? 0, ms);
                    continue;
                }
                results.set(r.id, part || { status: 0, headers: {}, body: null });
            }
            if (again.length === 0) return;
            if (expired) await refresh();
            if (throttled) await sleepImpl(backoffDelay(attempt, { retryAfterMs }), signal);
            pending = again;
        }
    }

    async function refresh() {
        state.refreshed = true;
        try {
            await refreshImpl(session);
        } catch {
            throw new Error('NOT_CONNECTED');
        }
    }

    /**
     * One batch POST. A 401 on the whole request refreshes once; a throttled
     * or failing whole request is retried with backoff; anything else is an
     * error with Google's own message.
     * @param {BatchRequest[]} pending
     * @returns {Promise<Map<string, BatchPart>>}
     */
    async function send(pending) {
        for (let attempt = 0; ; attempt++) {
            const boundary = `batch_${crypto.randomUUID()}`;
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.accessToken}`,
                    'Content-Type': `multipart/mixed; boundary=${boundary}`,
                },
                body: buildBatchBody(pending, boundary),
                signal: signal || undefined,
            });
            if (response.ok) return parseBatchResponse(response.headers.get('content-type'), await response.text());
            const text = await response.text().catch(() => '');
            if (response.status === 401 && !state.refreshed) {
                await refresh();
                continue;
            }
            if (RETRYABLE_STATUS.has(response.status) && attempt + 1 < maxAttempts) {
                await sleepImpl(backoffDelay(attempt, { retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) }), signal);
                if (signal?.aborted) throw new Error('Run cancelled');
                continue;
            }
            if (response.status === 401) throw new Error('NOT_CONNECTED');
            let message = `Google batch request failed: ${response.status}`;
            try { message = JSON.parse(text)?.error?.message || message; } catch { /* not JSON */ }
            throw new Error(message);
        }
    }
}

/**
 * The error message of a failed part, in Google's words when it gave some.
 * @param {BatchPart} part
 * @returns {string}
 */
function partError(part) {
    const body = part?.body;
    const message = body && typeof body === 'object' ? body.error?.message : null;
    if (message) return String(message);
    return part?.status ? `HTTP ${part.status}` : 'no answer from Google';
}

module.exports = {
    googleBatch,
    partError,
    GMAIL_BATCH_ENDPOINT,
    MAX_PARTS,
    DEFAULT_PARTS,
    // exposed for tests
    buildBatchBody,
    parseBatchResponse,
    isRetryablePart,
};
