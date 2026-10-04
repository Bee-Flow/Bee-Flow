// @typecheck
'use strict';
/**
 * Score: how worth automating a candidate is.
 *
 *   log(1 + perMonth × medianMinutes) × automatability × ease × wilsonLower(stability)
 *
 * Stability is the share of periods (weeks, fortnights or months, after the
 * cadence) in which the pattern showed up, taken at the lower Wilson bound so
 * three lucky weeks do not outrank a quarter of steady work.
 *
 * Returns reason CODES, never prose: the client translates them
 * (automations.repeating.reason.<code>).
 *
 * Pure: no I/O.
 */

const DAY = 86_400_000;

const REASON_CODES = Object.freeze(['frequent', 'regular', 'multiStep', 'measuredEffort', 'structuredInput', 'recent', 'early']);

const WRITE_VERB_RE = /(?:^|_|\.)(?:send|sent|reply|forward|post|create|created|append|insert|add|update|write|upload|uploaded|move|copy|rename|set)(?:_|$|s\b)/;

/**
 * Lower bound of the Wilson score interval.
 * @param {number} successes
 * @param {number} trials
 * @param {number} [z]
 */
function wilsonLower(successes, trials, z = 1.96) {
    if (!trials || trials <= 0) return 0;
    const p = Math.min(1, Math.max(0, successes / trials));
    const z2 = z * z;
    const denom = 1 + z2 / trials;
    const centre = p + z2 / (2 * trials);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
    return Math.max(0, (centre - margin) / denom);
}

/** Periods present / periods in the window, after the cadence. */
function stabilityOf(cad) {
    if (!cad) return [0, 1];
    if (cad.kind === 'monthly') return [cad.monthsPresent ?? 0, Math.max(1, cad.monthsWindow ?? 1)];
    if (cad.kind === 'biweekly') {
        const win = Math.max(1, Math.ceil((cad.weeksWindow ?? 1) / 2));
        // Each fortnight holds at most one occurrence week of a biweekly habit.
        return [Math.min(win, cad.weeksPresent ?? 0), win];
    }
    return [cad.weeksPresent ?? 0, Math.max(1, cad.weeksWindow ?? 1)];
}

/**
 * @param {any} c candidate with cadence and minutes
 * @param {{ now?: number }} [opts]
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreCandidate(c, opts = {}) {
    const now = opts.now ?? Date.now();
    const cad = c.cadence || {};
    const perMonth = Number(cad.perMonth) || 0;
    const range = c.minutes?.range || [1, 2];
    const medianMin = (range[0] + range[1]) / 2;
    const value = Math.log1p(perMonth * medianMin);

    const verbs = c.verbs || [];
    const hasWrite = verbs.some((v) => WRITE_VERB_RE.test(v));
    const regular = cad.kind && cad.kind !== 'irregular';
    let automatability = 0.5;
    if (hasWrite) automatability += 0.25;
    if (c.structured) automatability += 0.15;
    if (regular) automatability += 0.1;

    const steps = Math.max(1, verbs.length);
    const apps = Math.max(1, (c.apps || []).length);
    const ease = 1 / (1 + 0.08 * (steps - 1) + 0.05 * (apps - 1));

    const [present, window] = stabilityOf(cad);
    const stability = wilsonLower(present, window);
    // A floor so an early candidate with two weeks of history still ranks.
    const score = value * automatability * ease * Math.max(0.15, stability);

    const reasons = [];
    if (perMonth >= 4) reasons.push('frequent');
    // Weekends are part of a weekday habit's rhythm, not scatter in its gaps.
    if (regular && (cad.kind === 'daily' || cad.kind === 'weekdays' || (cad.cv ?? 1) <= 0.5)) reasons.push('regular');
    if (verbs.filter((v) => v !== 'mail.received' && v !== 'meeting.held').length >= 2) reasons.push('multiStep');
    if (c.minutes?.basis === 'measured') reasons.push('measuredEffort');
    if (c.structured) reasons.push('structuredInput');
    if (cad.lastTs != null && now - cad.lastTs <= 7 * DAY) reasons.push('recent');
    if (c.confidence === 'early') reasons.push('early');
    return { score: Math.round(score * 1000) / 1000, reasons };
}

module.exports = { scoreCandidate, wilsonLower, REASON_CODES };
