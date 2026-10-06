// @typecheck
/**
 * Waiting out a throttled API, the one way every client here does it.
 *
 * Google, Microsoft Graph and Nextcloud all answer an over-eager caller with
 * 429 (Graph and Nextcloud also 503) and usually a `Retry-After` header: an
 * integer number of seconds or an HTTP date (RFC 9110 §10.2.3). Their docs
 * agree on the rest: honour the header when it is there, otherwise back off
 * exponentially with some jitter, and never hammer straight back, because a
 * throttled call still counts against the limit.
 */

/**
 * `Retry-After` as milliseconds from now, or null when absent or unreadable.
 * @param {string | null | undefined} headerValue
 * @param {number} [now] - injectable for tests
 * @returns {number | null}
 */
function parseRetryAfter(headerValue, now = Date.now()) {
    if (headerValue === null || headerValue === undefined || headerValue === '') return null;
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(String(headerValue));
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now);
    return null;
}

/**
 * How long to wait before retry number `attempt` (0 for the first retry).
 * The server's own `Retry-After` wins when given; otherwise `baseMs * 2^attempt`
 * plus up to `jitterMs` of random spread, so many callers throttled at once do
 * not all come back in the same millisecond. Always clamped to `maxMs`: a
 * misconfigured or hostile server answering `Retry-After: 86400` must not park
 * a worker for a day.
 *
 * @param {number} attempt
 * @param {{ retryAfterMs?: number | null, baseMs?: number, maxMs?: number, jitterMs?: number, random?: () => number }} [opts]
 * @returns {number}
 */
function backoffDelay(attempt, { retryAfterMs = null, baseMs = 500, maxMs = 30_000, jitterMs = 250, random = Math.random } = {}) {
    const wait = retryAfterMs !== null && retryAfterMs !== undefined
        ? retryAfterMs
        : baseMs * Math.pow(2, Math.max(0, attempt)) + Math.floor(random() * jitterMs);
    return Math.min(Math.max(0, wait), maxMs);
}

/**
 * A sleep that an AbortSignal can cut short (the run was cancelled: stop
 * waiting, the caller checks the signal next) and that never keeps the
 * process alive on its own.
 * @param {number} ms
 * @param {AbortSignal | null} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal = null) {
    return new Promise((resolve) => {
        if (signal?.aborted || ms <= 0) { resolve(); return; }
        const timer = setTimeout(done, ms);
        timer.unref?.();
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', done);
            resolve();
        }
        signal?.addEventListener?.('abort', done, { once: true });
    });
}

/**
 * Can a request with this body be sent again? A string or bytes can; a stream
 * was consumed by the first attempt, so a retry would silently send an empty
 * payload.
 * @param {unknown} body
 * @returns {boolean}
 */
function isReplayableBody(body) {
    if (body === null || body === undefined) return true;
    if (typeof body === 'string' || Buffer.isBuffer(body) || ArrayBuffer.isView(body)) return true;
    if (body instanceof ArrayBuffer || body instanceof URLSearchParams) return true;
    // ReadableStream, Node stream, FormData with a stream part, ...
    return typeof body !== 'object';
}

module.exports = { parseRetryAfter, backoffDelay, sleep, isReplayableBody };
