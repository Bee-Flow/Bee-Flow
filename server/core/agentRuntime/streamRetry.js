/**
 * Stream retry helpers — extracted from chatStream.js so they can be unit
 * tested without dragging in the full agent-runtime require graph (stores,
 * providers, DB pools).
 */

/**
 * Classify an error as transient (retryable) or permanent.
 * Returns an object with { retryable, errorType, userMessage }.
 */
const log = require('../../telemetry/log');
function classifyStreamError(error) {
    const msg = error.message || '';
    const isNetworkError = error instanceof TypeError && /network|fetch|ECONNRESET|ETIMEDOUT/i.test(msg);
    const isTimeout = msg.includes('timed out') || msg.includes('AbortError') || error.name === 'TimeoutError';
    const statusMatch = msg.match(/API error (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : null;
    // Claude SDK exposes .status directly on the error object
    const httpStatus = status || error.status || null;
    // Detect Claude-specific overloaded_error from the error body or status
    const isOverloaded = /overloaded/i.test(msg) || error.error?.type === 'overloaded_error' || httpStatus === 529;

    // Transient errors — worth retrying
    if (isNetworkError) return { retryable: true, errorType: 'network', userMessage: 'Network error — please try again' };
    if (isTimeout) return { retryable: true, errorType: 'timeout', userMessage: 'Request timed out — please try again' };
    if (isOverloaded) return { retryable: true, errorType: 'overloaded', userMessage: 'The AI service is temporarily overloaded — retrying automatically' };
    if (httpStatus === 429) return { retryable: true, errorType: 'rate_limit', userMessage: 'The AI service is temporarily busy — please try again in a moment' };
    if (httpStatus && httpStatus >= 500) return { retryable: true, errorType: 'server', userMessage: 'The AI service encountered a temporary error — please try again' };

    // Permanent errors — do not retry
    if (httpStatus === 413) return { retryable: false, errorType: 'payload_too_large', userMessage: 'Message too large — try sending fewer or smaller images' };
    if (httpStatus === 400) return { retryable: false, errorType: 'bad_request', userMessage: msg };
    if (httpStatus === 401 || httpStatus === 403) return { retryable: false, errorType: 'auth', userMessage: 'Authentication error with AI service' };

    // Context overflow patterns (various providers)
    if (/context.*(length|window|overflow|limit|exceeded)/i.test(msg) || /max.*token/i.test(msg)) {
        return { retryable: false, errorType: 'context_overflow', userMessage: 'Message too large for the AI model — try a shorter conversation or fewer images' };
    }

    // Unknown — don't retry
    return { retryable: false, errorType: 'unknown', userMessage: msg || 'An unexpected error occurred' };
}

/**
 * Retry an async operation with exponential backoff.
 * Only retries on transient errors as classified by classifyStreamError.
 *
 * IMPORTANT for callers: `fn` is re-invoked from scratch on retry. Any
 * accumulator the streamed events write into (tool calls, content buffers)
 * MUST be reset at the top of `fn`, or a stream that emitted events before
 * dropping leaves duplicates behind — see the chatStream call site.
 *
 * @param {Function} fn - Async function to execute
 * @param {number} maxRetries - Maximum retry attempts (default 3)
 * @param {AbortSignal} [signal] - client-disconnect signal; aborts the loop
 * @returns {Promise} Result of fn()
 */
async function retryStreamCall(fn, maxRetries = 3, signal = null) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Don't waste cycles on a retry if the client already gave up.
        if (signal?.aborted) {
            const err = new Error('Client aborted before retry');
            err.name = 'AbortError';
            throw err;
        }
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const classified = classifyStreamError(error);
            if (!classified.retryable || attempt >= maxRetries) {
                // Attach classification to the error for downstream handling
                error._classified = classified;
                throw error;
            }
            if (signal?.aborted) {
                error._classified = classified;
                throw error;
            }
            const baseDelay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
            const jitter = Math.random() * baseDelay * 0.5; // 0-50% jitter
            const delayMs = Math.min(Math.round(baseDelay + jitter), 10000); // cap at 10s
            log.info(`[AgentRuntime] Retry attempt ${attempt + 1}/${maxRetries} after ${classified.errorType} error (waiting ${delayMs}ms): ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    throw lastError;
}

module.exports = { classifyStreamError, retryStreamCall };
