/**
 * App Studio Builder — one model round on the wire.
 *
 * The retry/assembly shell is shared with the automation builder
 * (routes/ai/builderShared.js); this module pins THIS route's thinking
 * emitter and log prefix onto it.
 */

const { streamWithRetry: sharedStreamWithRetry } = require('../builderShared');

// THIS route's SSE thinking shapes: no partId on start/stop; deltas go out
// as { delta } (the frontend renders a single rolling thinking bubble).
const APP_SSE_THINKING = {
    start: (send, part) => send('thinking_start', { partId: part && part.partId }),
    delta: (send, { text, partId }) => send('thinking', { delta: text, partId }),
    stop: (send, part) => send('thinking_stop', { partId: part && part.partId }),
};

// Retry/assembly shell shared with the automation builder (builderShared.js);
// this wrapper pins the route's thinking emitter and log prefix.
function streamWithRetry(adapter, cfg, modelId, messages, options, opts = {}) {
    return sharedStreamWithRetry(adapter, cfg, modelId, messages, options, {
        emitThinking: APP_SSE_THINKING,
        logPrefix: '[AppStudioBuilder]',
        ...opts,
    });
}

module.exports = { streamWithRetry, APP_SSE_THINKING };
