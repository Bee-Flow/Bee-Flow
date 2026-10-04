// @typecheck
'use strict';
/**
 * Effort: how many minutes one occurrence of a pattern costs the user.
 *
 * Measured when there are spans to measure (the time from the first to the
 * last action of a session, or from a mail arriving to the last action on
 * it): the median, capped, as a ±25% range. Otherwise a heuristic: the sum of
 * per-verb constants. Always a range, never a single precise-looking number.
 *
 * Pure: no I/O.
 */

const { median } = require('./periodicity');

const MAX_MEASURED_MIN = 30;
const MIN_MEASURED_SAMPLES = 3;
// A span shorter than this is the tool latency, not the user's work.
const MIN_MEASURED_SPAN_MS = 60_000;

/** Per-verb minutes [lo, hi], by exact verb or by tool-name keyword. */
const VERB_MINUTES = {
    'mail.received': [1, 2],
    'mail.sent': [3, 6],
    'file.created': [2, 5],
    'file.changed': [2, 4],
    'doc.uploaded': [1, 3],
    // The meeting itself is not the work an automation takes over.
    'meeting.held': [0, 0],
};
/** @type {Array<[RegExp, number[]]>} */
const KEYWORD_MINUTES = [
    [/(?:^|_)(?:search|list|find|get|read|fetch|lookup)(?:_|$)/, [0.5, 1]],
    [/(?:^|_)(?:send|reply|forward|post|message)(?:_|$)/, [2, 4]],
    [/(?:^|_)(?:create|append|insert|add|update|write|upload|move|copy|rename|set)(?:_|$)/, [1, 3]],
];
const DEFAULT_MINUTES = [1, 2];

/** @param {string} verb */
function verbMinutes(verb) {
    if (VERB_MINUTES[verb]) return VERB_MINUTES[verb];
    for (const [re, range] of KEYWORD_MINUTES) if (re.test(verb)) return range;
    return DEFAULT_MINUTES;
}

/**
 * @param {{ verbs?: string[], spansMs?: number[] }} c
 * @returns {{ range: [number, number], basis: 'measured'|'heuristic' }}
 */
function estimateMinutes(c) {
    const spans = (c.spansMs || []).filter((s) => Number.isFinite(s) && s >= MIN_MEASURED_SPAN_MS);
    if (spans.length >= MIN_MEASURED_SAMPLES) {
        const med = Math.min(MAX_MEASURED_MIN, median(spans) / 60_000);
        const lo = Math.max(1, Math.round(med * 0.75));
        const hi = Math.max(lo + 1, Math.round(med * 1.25));
        return { range: [lo, hi], basis: 'measured' };
    }
    let lo = 0;
    let hi = 0;
    for (const v of c.verbs || []) {
        const [a, b] = verbMinutes(v);
        lo += a;
        hi += b;
    }
    const L = Math.max(1, Math.round(lo));
    return { range: [L, Math.max(L + 1, Math.round(hi))], basis: 'heuristic' };
}

/**
 * Minutes per month as a range: per-occurrence minutes × perMonth.
 * @param {{ range: [number, number] }} minutes
 * @param {number} perMonth
 * @returns {[number, number]}
 */
function minutesPerMonth(minutes, perMonth) {
    const p = Number.isFinite(perMonth) ? perMonth : 0;
    return [Math.round(minutes.range[0] * p), Math.round(minutes.range[1] * p)];
}

module.exports = { estimateMinutes, minutesPerMonth, verbMinutes };
