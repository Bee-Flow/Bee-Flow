// @typecheck
/**
 * Shared prompt utilities — no dependencies on agentRuntime or other heavy modules.
 * This avoids circular dependency issues when browser/ modules need prompt processing.
 */

// Text substituted for {Time}/{DateTime} when the caller defers clock tags.
// Byte-stable, and points the model at the volatile system block that carries
// the real timestamp.
const CLOCK_TAG_PLACEHOLDER = 'the current date/time given in the "Now:" line below';

/**
 * Process dynamic tags in a system prompt.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {boolean} [options.deferClockTags=false]
 *        When true, `{Time}` and `{DateTime}` are NOT expanded to a live clock
 *        reading — they are replaced with a fixed pointer to the caller's
 *        separate "Now:" line. Callers that put this prompt inside a
 *        prompt-cached block must set this: a second-resolution timestamp in
 *        the cached prefix makes every request a cache miss. `{Date}` is still
 *        expanded inline (it only rotates daily).
 */
function processSystemPrompt(prompt, options = {}) {
    if (!prompt) return prompt;

    const { deferClockTags = false } = options;
    const now = new Date();

    // {Date} -> Unambiguous Date String (e.g. "Tuesday, February 10, 2026")
    /** @type {Intl.DateTimeFormatOptions} */
    const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    let processed = prompt.replace(/{Date}/g, now.toLocaleDateString('en-US', dateOptions));

    if (deferClockTags) {
        return processed
            .replace(/{Time}/g, CLOCK_TAG_PLACEHOLDER)
            .replace(/{DateTime}/g, CLOCK_TAG_PLACEHOLDER);
    }

    // {Time} -> Local Time String (e.g. "4:08:12 PM")
    processed = processed.replace(/{Time}/g, now.toLocaleTimeString('en-US'));

    // {DateTime} -> Local Date & Time String (e.g. "2/10/2026, 4:08:12 PM")
    /** @type {Intl.DateTimeFormatOptions} */
    const dateTimeOptions = { ...dateOptions, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true };
    processed = processed.replace(/{DateTime}/g, now.toLocaleString('en-US', dateTimeOptions));

    return processed;
}

module.exports = { processSystemPrompt, CLOCK_TAG_PLACEHOLDER };
