/**
 * Thought narrator — one short phrase for the builder's reasoning stream.
 *
 * While the builder model thinks, the client shows the raw last line of the
 * reasoning; that means little to most people watching the canvas. A tiny
 * side model (lfm2.5-350m on the local llama-server) rewrites a bounded
 * window of the fresh reasoning text into a present-tense phrase — "Choosing
 * the schedule" — and the client renders that instead.
 *
 * The owner's constraint is what shapes this module: the side model only ever
 * sees a fixed system instruction and the tail of the reasoning text received
 * since the previous summary. No brief, no draft, no history, no tool results,
 * no identity. The payload is built from two literals and one string buffer,
 * and the test suite proves a sentinel fed anywhere else never reaches
 * `chat()`.
 *
 * The narrator plugs in at the `send` seam of the SSE route: `wrap(send)`
 * returns a send that forwards every event untouched FIRST and then observes
 * `thinking` / `thinking_stop`, so the shared stream shell in builderShared.js
 * is unchanged and the narrator sees exactly what the client sees.
 *
 * Cadence is skip-not-queue. The LFM child runs with `--parallel 1`, so a
 * second call queued behind a slow one would answer about text that is already
 * old; when a call is in flight new deltas simply accumulate and the next tick
 * summarises them once the previous call has resolved.
 */

'use strict';
const logger = require('../../../telemetry/log');

// Tuned on the demo box against lfm2.5-350m (2026-09-10): the plain "at most 8
// words" wording produced two-word noun stubs ("Inspect schema"), and a
// few-shot version echoed its own labels ("Caption: …") and ran on to a
// second line. Asking for a lower bound and a leading verb, with three
// examples of the FORM, gave usable captions in under 80 ms; the sanitiser
// below still peels a label a small model may prepend anyway.
const SYSTEM = "You summarise a fragment of an AI assistant's working notes while it builds an automation. Reply with ONE phrase of 3 to 8 words that starts with a verb and says what it is doing right now, in the same language as the fragment — for example 'Choosing the weekday schedule', 'Wiring the error branch to a stop step', 'Checking the HTTP request schema'. No quotes, no full stop, no explanation.";

// Three consecutive timeouts/errors and the narrator goes quiet for the rest
// of the turn: the client keeps its own fallbacks (todo → neutral line), and a
// model that is down should not add a failing request every 2.5 s to a build
// that is otherwise fine.
const MAX_CONSECUTIVE_FAILURES = 3;

// Resolved on first use rather than at module load: llmClient pulls in the
// whole provider stack, and the narrator's tests inject a fake `chat`.
function defaultChat() {
    const llmClient = require('../../../core/llm/llmClient');
    return llmClient.chat.bind(llmClient);
}

// A label some small models prepend even when told not to ("Caption: …",
// "Samenvatting: …"); peeled before the quotes so a quoted label also goes.
const LEADING_LABEL = /^(caption|summary|phrase|antwoord|samenvatting|onderschrift)\s*:\s*/i;
const LEADING_QUOTES = /^["'“”‘’«»`]+/;
const TRAILING_QUOTES = /["'“”‘’«»`]+$/;
const TRAILING_PUNCT = /[.!;:…]+$/;

/**
 * First non-empty line, unquoted, without trailing punctuation, whitespace
 * collapsed, capped at `maxWords`. Quotes and punctuation are peeled in a loop
 * because small models produce both orders ('"Foo."' and '"Foo".').
 */
function sanitiseSummary(raw, maxWords) {
    if (typeof raw !== 'string') return '';
    const line = raw.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
    let text = line;
    for (;;) {
        const next = text
            .replace(LEADING_LABEL, '')
            .replace(LEADING_QUOTES, '')
            .replace(TRAILING_QUOTES, '')
            .replace(TRAILING_PUNCT, '')
            .trim();
        if (next === text) break;
        text = next;
    }
    const words = text.split(/\s+/).filter(Boolean);
    return words.slice(0, maxWords).join(' ');
}

function createThoughtNarrator({
    send,
    modelId,
    chat,
    now = Date.now,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
    minIntervalMs = 2500,
    minNewChars = 120,
    windowChars = 600,
    timeoutMs = 1500,
    maxWords = 8,
    log = logger.warn,
} = {}) {
    // Falsy model id = feature off. wrap() hands back the original send so the
    // route pays nothing — not even a closure — when no admin set the key.
    const enabled = typeof modelId === 'string' && modelId.trim().length > 0;

    let emit = typeof send === 'function' ? send : null;
    let chatFn = chat;

    // Per-part buffers of text not yet summarised. Only the part that most
    // recently produced a delta is summarised; an older part's leftover is
    // stale by definition (the model has moved on) and is dropped.
    const pending = new Map();
    let activePartId = null;

    let inFlight = false;
    let lastCallStartedAt = null;
    let timer = null;
    let closed = false;
    let disabled = false;
    let failures = 0;
    let loggedFailure = false;
    let lastText = null;
    let seq = 0;

    function clearTimer_() {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
    }

    function tick() {
        timer = null;
        if (closed || disabled || inFlight) return;
        const partId = activePartId;
        const text = partId === null ? '' : (pending.get(partId) || '');
        if (text.length < minNewChars) return;

        // The buffer is consumed at call start: whatever arrives from here on
        // is "since the previous summary", even if this reply is dropped.
        pending.set(partId, '');
        const fragment = text.length > windowChars ? text.slice(text.length - windowChars) : text;

        inFlight = true;
        lastCallStartedAt = now();

        let result;
        try {
            if (!chatFn) chatFn = defaultChat();
            // Exactly two messages, built from a literal and the buffer. Anything
            // else the route knows about (brief, draft, user) is not in scope
            // here, and must stay that way.
            result = Promise.resolve(chatFn(modelId, [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: fragment },
            ], { maxTokens: 24, temperature: 0, timeoutMs, reasoningEffort: 'none' }));
        } catch (err) {
            result = Promise.reject(err);
        }

        result.then(
            (reply) => { inFlight = false; onReply(partId, reply); },
            (err) => { inFlight = false; onFailure(err); },
        );
    }

    function onReply(partId, reply) {
        if (closed) return;
        failures = 0;
        const text = sanitiseSummary(reply && reply.content, maxWords);
        if (text && text !== lastText) {
            lastText = text;
            seq += 1;
            if (emit) {
                try { emit('thinking_summary', { partId, text, seq }); } catch (_) { /* the wire is the route's problem */ }
            }
        }
        maybeSchedule();
    }

    function onFailure(err) {
        if (closed) return;
        failures += 1;
        if (!loggedFailure) {
            loggedFailure = true;
            const reason = (err && err.message) ? err.message : String(err);
            log(`[thoughtNarrator] ${modelId}: ${reason} (disables after ${MAX_CONSECUTIVE_FAILURES} consecutive failures)`);
        }
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
            disabled = true;
            clearTimer_();
            pending.clear();
            return;
        }
        maybeSchedule();
    }

    function maybeSchedule() {
        if (closed || disabled || inFlight || timer !== null) return;
        const text = activePartId === null ? '' : (pending.get(activePartId) || '');
        if (text.length < minNewChars) return;
        const due = lastCallStartedAt === null ? 0 : lastCallStartedAt + minIntervalMs;
        const wait = due - now();
        if (wait <= 0) {
            tick();
            return;
        }
        timer = setTimer(tick, wait);
    }

    function observe(event, data) {
        if (closed || disabled) return;
        if (event === 'thinking') {
            const partId = data && data.partId !== undefined ? data.partId : null;
            const delta = data && typeof data.text === 'string' ? data.text : '';
            if (!delta) return;
            if (partId !== activePartId) {
                // A new reasoning block: the previous block's leftover would be
                // summarised out of order, so it goes.
                if (activePartId !== null) pending.delete(activePartId);
                activePartId = partId;
            }
            pending.set(partId, (pending.get(partId) || '') + delta);
            maybeSchedule();
        } else if (event === 'thinking_stop') {
            maybeSchedule();
        }
    }

    function wrap(target) {
        if (!enabled) return target;
        if (emit === null && typeof target === 'function') emit = target;
        return (event, data) => {
            // Forward first, observe second: the narrator can never delay or
            // reorder what the client sees, and a bug in here cannot break
            // the stream.
            target(event, data);
            try { observe(event, data); } catch (err) {
                if (!loggedFailure) {
                    loggedFailure = true;
                    log(`[thoughtNarrator] observe failed: ${err && err.message ? err.message : err}`);
                }
            }
        };
    }

    function close() {
        closed = true;
        clearTimer_();
        pending.clear();
        activePartId = null;
    }

    return { wrap, close };
}

module.exports = {
    createThoughtNarrator,
    sanitiseSummary,
    SYSTEM,
    MAX_CONSECUTIVE_FAILURES,
};
