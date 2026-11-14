// @typecheck strict
/**
 * Deadlines of the transcription use cases, read from the environment once.
 */

'use strict';

/**
 * A millisecond deadline from the environment; unset or empty means the
 * default, a non-numeric or negative value is refused at boot.
 * @param {string} name @param {number} fallback
 */
function envMs(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number of milliseconds, got ${JSON.stringify(raw)}`);
    return Math.trunc(n);
}

// The cut-off of one meeting-notes LLM call made from a route, the same env
// and default as the pipeline's own calls (core/meetingNotes/summaryLlm.js).
// Without one, a generic OpenAI-compatible adapter waits with no deadline.
const MEETING_LLM_TIMEOUT_MS = envMs('MEETING_LLM_TIMEOUT_MS', 540_000);

module.exports = { envMs, MEETING_LLM_TIMEOUT_MS };
