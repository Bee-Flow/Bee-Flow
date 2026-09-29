/**
 * Automation Builder — the model calls: adapter.chat behind a bounded retry,
 * and its streaming counterpart pinned to this route's SSE thinking shapes.
 */

const { isTransientChatError, streamWithRetry: sharedStreamWithRetry } = require('../builderShared');
const log = require('../../../telemetry/log');

/**
 * Call adapter.chat with a bounded retry on transient errors and exponential
 * backoff + jitter. `baseDelayMs` is injectable so tests run fast.
 */
async function chatWithRetry(adapter, cfg, modelId, messages, options, { retries = 2, baseDelayMs = 500 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await adapter.chat(cfg.apiKey, cfg.url, modelId, messages, options);
        } catch (e) {
            lastErr = e;
            if (attempt === retries || !isTransientChatError(e)) throw e;
            const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            log.warn(`[AutomationBuilder] chat attempt ${attempt + 1} failed (${e.message}); retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

// THIS route's SSE thinking shapes: partId-addressed start/delta/stop so the
// chat panel can render multiple reasoning blocks per turn.
const AUTOMATION_SSE_THINKING = {
    start: (send, { partId, redacted }) => send('thinking_start', { partId, redacted }),
    delta: (send, { partId, text }) => send('thinking', { partId, text }),
    stop: (send, { partId, redacted }) => send('thinking_stop', { partId, redacted }),
};

// Streaming counterpart of chatWithRetry — retry/assembly shell shared with
// the app-studio builder (builderShared.js); this wrapper pins the route's
// thinking emitter and log prefix.
function streamWithRetry(adapter, cfg, modelId, messages, options, opts = {}) {
    return sharedStreamWithRetry(adapter, cfg, modelId, messages, options, {
        emitThinking: AUTOMATION_SSE_THINKING,
        logPrefix: '[AutomationBuilder]',
        ...opts,
    });
}

module.exports = { chatWithRetry, streamWithRetry };
