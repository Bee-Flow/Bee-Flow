/**
 * Direct-chat display segments (BFSF-261, part a).
 *
 * In the streamed tool loop, text the model emits BEFORE a tool call (the
 * "Ik zoek het even voor je op." preamble) is streamed live, then the server
 * resets its accumulator (`fullContent = ''`) for the follow-up round — but
 * the client keeps appending every 'content' event verbatim. The result:
 *   - live view: "…find anything." + "Good, I have…" glue into
 *     "anything.Good, I have" (the reported missing-space symptom);
 *   - persistence: only the LAST round's text is saved, so the preamble
 *     silently vanishes on reload (and on the end-of-turn PII
 *     content_replace) — live view and stored view diverge.
 *
 * This helper records each finished round's visible text and:
 *   1. lazily emits exactly ONE '\n\n' separator before the FIRST visible
 *      text of the next round (lazy → a tool-only or muted pipeline round
 *      never leaves a stray blank paragraph);
 *   2. joins all segments for persistence so the stored message matches what
 *      was streamed.
 *
 * Wiring rule: ONLY the follow-up stream callback gets the wrapped
 * streamContent — the primary stream never needs a separator, and wrapping it
 * would prepend one to retried primary streams.
 */

function createDisplaySegments() {
    const segments = [];
    let pendingSeparator = false;

    return {
        /**
         * Record the finished round's visible text. Call at each round
         * boundary BEFORE `fullContent` is reset. Rounds without visible text
         * (tool-only, muted pipeline steps) record nothing and never arm the
         * separator.
         */
        onRoundEnd(fullContent) {
            if (fullContent && fullContent.trim()) {
                segments.push(fullContent);
                pendingSeparator = true;
            }
        },

        /**
         * Wrap a streamContent(text) sink so the first visible text after a
         * recorded round is preceded by exactly one paragraph break. The
         * separator bypasses the untokeniser (it's pure whitespace) via the
         * raw `send` channel.
         */
        wrapStreamContent(streamContent, send) {
            return (text) => {
                if (pendingSeparator && text) {
                    pendingSeparator = false;
                    send('content', { text: '\n\n' });
                }
                streamContent(text);
            };
        },

        /** True when at least one earlier round produced visible text. */
        hasSegments() {
            return segments.length > 0;
        },

        /**
         * Join all recorded segments + the final round's text with paragraph
         * breaks — the persisted content now matches the streamed view.
         */
        joinFinal(fullContent) {
            return [...segments, fullContent]
                .filter(s => s && s.trim())
                .join('\n\n');
        },
    };
}

module.exports = { createDisplaySegments };
