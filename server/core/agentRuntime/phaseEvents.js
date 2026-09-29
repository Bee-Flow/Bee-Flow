/**
 * Pre-LLM phase events.
 *
 * Each chat runtime opens an SSE stream and writes events with its own
 * `send(event, data)` helper (or in the streaming agent path, a
 * `onEvent(type, data)` callback). These helpers wrap that emitter so a
 * single `phase` event format flows through to the UI:
 *
 *   { stage, status: 'start' | 'end', detail?, durationMs? }
 *
 * The UI uses these to render a status line ("Reading attachment…",
 * "Searching knowledge base…") above the typing dots so users see what is
 * happening during the seconds before the first LLM token streams.
 */

function emitPhase(send, stage, detail) {
    if (typeof send !== 'function' || !stage) return;
    try {
        send('phase', { stage, status: 'start', detail: detail || undefined });
    } catch (_) { /* never block the chat on telemetry failures */ }
}

function emitPhaseEnd(send, stage, durationMs) {
    if (typeof send !== 'function' || !stage) return;
    try {
        send('phase', { stage, status: 'end', durationMs: Number.isFinite(durationMs) ? durationMs : undefined });
    } catch (_) { /* swallow */ }
}

async function withPhase(send, stage, detail, fn) {
    emitPhase(send, stage, detail);
    const t = Date.now();
    try {
        return await fn();
    } finally {
        emitPhaseEnd(send, stage, Date.now() - t);
    }
}

/**
 * The privacy-scan phase, reporting which part of a big paste it is on.
 *
 * Text over one window is scanned window by window against a CPU model at
 * roughly 4ms/char, so a 40k-char paste is minutes of work. A single "start"
 * event at the top of that is indistinguishable from a hang — and the stream
 * stays silent long enough for a proxy to consider it dead. Re-emitting the
 * phase per completed window fixes both: the user sees "part 3/6", and bytes
 * keep flowing.
 *
 * Every one of the three chat runtimes used to derive the stage from its own
 * copy of `len > 8000`, which is the window size spelled out a fourth time.
 * Ask the scanner instead.
 *
 * @param {function} send  the runtime's SSE emitter / onEvent callback
 * @param {string} text    the text about to be scanned
 * @returns {{stage:string, onProgress:function, end:function}}
 */
function startPrivacyScanPhase(send, text) {
    let total = 1;
    try {
        total = require('../privacy/piiDetection').windowCountFor(text || '');
    } catch (_) { /* scanner unavailable → treat as a single part */ }
    const stage = total > 1 ? 'privacy_scan_large' : 'privacy_scan';
    const startedAt = Date.now();
    // The detail is the part being worked on, not the count finished — so the
    // line reads "part 1/6" the moment the first window is sent, and the
    // multi-part copy is never rendered with an empty placeholder.
    emitPhase(send, stage, total > 1 ? `1/${total}` : undefined);
    return {
        stage,
        onProgress: ({ done, total: n } = {}) => {
            if (n > 1 && done < n) emitPhase(send, stage, `${done + 1}/${n}`);
        },
        end: () => emitPhaseEnd(send, stage, Date.now() - startedAt),
    };
}

/** The text a message contributes to a scan (string or content-block array). */
function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.find(p => p.type === 'text')?.text || '';
    return '';
}

module.exports = { emitPhase, emitPhaseEnd, withPhase, startPrivacyScanPhase, messageText };
