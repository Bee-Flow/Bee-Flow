// @typecheck
'use strict';

/**
 * Chat signals: the read-time suppression every reader applies.
 *
 * `chat_signal_counts` holds no identifiers, but it is personal data for the
 * controller wherever few people contribute: the same controller holds
 * `ai_usage_log` and `guardrail_events` keyed by user, so a sparse cell can be
 * linked to a person. Every path that shows a figure (the summary route, C1,
 * C3, evidence and the RoPA) therefore goes through these helpers:
 *
 *   - an employee-surface figure is hidden when fewer than K.outcomes distinct
 *     people used the surface in the window (K.kinds for kinds of data);
 *   - a count of 1-4 reads '<5', and so does a percentage whose numerator is;
 *   - when exactly one cell reads '<5' next to a shown total, one more cell is
 *     hidden so the small one cannot be worked out by subtraction;
 *   - employee windows cover completed ISO weeks only, so a growing
 *     current-week row cannot be differenced day by day.
 *
 * Raw numbers enter these functions and never leave them: the output holds
 * only 0, integers of 5 or more, '<5', 'hidden', bands and null.
 *
 * Pure: requires only the vocabulary. Dates are passed in.
 */

const {
    OUTCOMES, KINDS, K, granularityFor, isEmployeeSurface,
} = require('./chatMonitoringVocab');

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @typedef {number|'<5'|'hidden'} Cell */

/**
 * The UTC calendar day of a Date, an ISO timestamp or a 'YYYY-MM-DD' string.
 * @param {Date|string|number|null|undefined} v
 * @returns {string|null}
 */
function utcDay(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string' && DAY_RE.test(v)) return v;
    const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
}

/** @param {string} day @param {number} n */
function addDays(day, n) {
    return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday (UTC) of the ISO week that holds `day`. @param {string} day */
function isoMonday(day) {
    const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
    return addDays(day, -((dow + 6) % 7));
}

/**
 * The first Monday 00:00 UTC at or after a moment. A start at Monday 09:00
 * leaves that week partial, so its first complete week begins a week later.
 * @param {Date|string} moment
 * @returns {string|null}
 */
function mondayOnOrAfter(moment) {
    const day = utcDay(moment);
    if (!day) return null;
    const t = moment instanceof Date ? moment.getTime() : Date.parse(String(moment));
    const startsAfterMidnight = Number.isFinite(t) && t > Date.parse(`${day}T00:00:00.000Z`);
    const first = startsAfterMidnight ? addDays(day, 1) : day;
    const monday = isoMonday(first);
    return monday < first ? addDays(monday, 7) : monday;
}

/**
 * The period a turn at `now` is counted in: the ISO-week Monday for 'week',
 * the UTC date for 'day'.
 * @param {'week'|'day'} granularity
 * @param {Date} [now]
 */
function periodStart(granularity, now = new Date()) {
    const day = utcDay(now);
    return granularity === 'week' ? isoMonday(day) : day;
}

/**
 * A count as it may be shown: 0, '<5' for 1-4, else the integer.
 * @param {number} n
 * @returns {Cell}
 */
function band(n) {
    const v = Math.max(0, Math.trunc(Number(n) || 0));
    if (v === 0) return 0;
    return v < K.cell ? '<5' : v;
}

/**
 * A number of people, only ever as a band.
 * @param {number|null|undefined} n
 * @returns {'<5'|'5-9'|'10-24'|'25+'|null}
 */
function contributorBand(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return null;
    const v = Number(n);
    if (v < 5) return '<5';
    if (v < 10) return '5-9';
    if (v < 25) return '10-24';
    return '25+';
}

/**
 * Primary and complementary suppression over one set of cells that add up to
 * a shown total. Returns the same keys; zeros stay 0.
 * @param {Record<string, number>} counts raw integers
 * @returns {Record<string, Cell>}
 */
function suppressCells(counts) {
    /** @type {Record<string, Cell>} */
    const out = {};
    const keys = Object.keys(counts || {});
    for (const k of keys) out[k] = band(counts[k]);
    const small = keys.filter(k => out[k] === '<5');
    if (small.length === 1) {
        const shown = keys.filter(k => typeof out[k] === 'number' && out[k] > 0);
        if (shown.length) {
            let smallest = shown[0];
            for (const k of shown) if (Number(counts[k]) < Number(counts[smallest])) smallest = k;
            out[smallest] = 'hidden';
        }
    }
    return out;
}

/**
 * A percentage as it may be shown.
 * @param {number} numerator raw
 * @param {number} denominator raw
 * @param {{ hiddenIfAny?: Cell[] }} [opts] the suppressed cells the numerator is made of
 * @returns {number|'<5'|'hidden'|null}
 */
function pct(numerator, denominator, { hiddenIfAny = [] } = {}) {
    const d = Number(denominator) || 0;
    if (d <= 0) return null;
    if ((hiddenIfAny || []).includes('hidden')) return 'hidden';
    const n = Math.max(0, Number(numerator) || 0);
    if (n === 0) return 0;
    if (n < K.cell) return '<5';
    return Math.round((100 * n) / d);
}

/**
 * The window a reader may look at for one surface.
 *
 *   employee surfaces  completed ISO weeks only (period_start + 7 <= today),
 *                      starting on or after the first Monday at or after
 *                      `effectiveFrom`, within the last `days` days rounded
 *                      out to whole weeks;
 *   agent_public       completed UTC days (period_start < today) on or after
 *                      the day of `effectiveFrom`.
 *
 * `days` has a floor of 7, so a window can always hold one whole week.
 * Returns null when no completed period is in the window yet.
 *
 * @param {string} surface
 * @param {{ days?: number, effectiveFrom?: Date|string|null, today?: Date|string }} opts
 * @returns {{ granularity: 'week'|'day', from: string, to: string, toExclusive: string } | null}
 */
function windowFor(surface, { days = 30, effectiveFrom = null, today = new Date() } = {}) {
    const t = utcDay(today);
    if (!t) return null;
    const span = Math.max(7, Math.trunc(Number(days) || 30));
    if (granularityFor(surface) === 'day') {
        const to = addDays(t, -1);
        let from = addDays(t, -span);
        const start = effectiveFrom ? utcDay(effectiveFrom) : null;
        if (start && start > from) from = start;
        return from <= to ? { granularity: 'day', from, to, toExclusive: addDays(to, 1) } : null;
    }
    const to = addDays(isoMonday(t), -7);
    let from = isoMonday(addDays(t, -span));
    const start = effectiveFrom ? mondayOnOrAfter(effectiveFrom) : null;
    if (start && start > from) from = start;
    return from <= to ? { granularity: 'week', from, to, toExclusive: addDays(to, 7) } : null;
}

/**
 * The last four completed ISO weeks, for the contributor band the admin card
 * shows (amendment 19) and C3's small-group warning.
 * @param {Date|string} [today]
 */
function lastFourWeeks(today = new Date()) {
    const to = addDays(isoMonday(utcDay(today)), -7);
    const from = addDays(to, -21);
    return { granularity: 'week', from, to, toExclusive: addDays(to, 7) };
}

const sumWhere = (rows, pred) => rows.reduce((a, r) => a + (pred(r) ? (Number(r.turns) || 0) : 0), 0);

/**
 * The suppressed figures of one surface over one window: the shape the
 * summary route returns and C1 writes into evidence (build spec 3.6). The
 * window itself (and `no_full_period`) is the caller's.
 *
 * @param {{
 *   outcomeRows: Array<{surface?: string, value: string, destination: string, provider_type?: string, turns: number}>,
 *   kindRows?: Array<{surface?: string, value: string, protection: string, destination?: string, turns: number}>,
 *   contributors?: number|null,
 *   surface: string,
 *   kindsActive?: boolean,
 * }} input
 */
function surfaceFigures({ outcomeRows, kindRows = [], contributors = null, surface, kindsActive = false }) {
    const employee = isEmployeeSurface(surface);
    const mine = (r) => !r.surface || r.surface === surface;
    if (employee && !(Number(contributors) >= K.outcomes)) {
        return { status: 'suppressed', k: K.outcomes };
    }
    const rows = (outcomeRows || []).filter(mine);
    /** @type {Record<string, number>} */
    const raw = {};
    for (const o of OUTCOMES) raw[o] = sumWhere(rows, r => r.value === o);
    const turns = OUTCOMES.reduce((a, o) => a + raw[o], 0);
    /** @type {Record<string, any>} */
    const out = { status: turns > 0 ? 'shown' : 'no_data' };
    if (employee) out.contributors = contributorBand(contributors);
    out.turns = band(turns);
    if (turns === 0) return out;

    const cells = suppressCells(raw);
    const found = raw.protected + raw.blocked + raw.sent_unprotected;
    const externalish = (r) => r.destination === 'external' || r.destination === 'unknown';
    const unscannedExternal = sumWhere(rows, r => (r.value === 'unscanned' || r.value === 'scan_failed_open') && externalish(r));
    out.outcomes = cells;
    out.pct = {
        scanned: pct(raw.clean + found, turns, { hiddenIfAny: [cells.clean, cells.protected, cells.blocked, cells.sent_unprotected] }),
        protected_of_found: pct(raw.protected + raw.blocked, found, { hiddenIfAny: [cells.protected, cells.blocked] }),
        blocked: pct(raw.blocked, turns, { hiddenIfAny: [cells.blocked] }),
        sent_unprotected: pct(raw.sent_unprotected, turns, { hiddenIfAny: [cells.sent_unprotected] }),
        failed_open: pct(raw.scan_failed_open, turns, { hiddenIfAny: [cells.scan_failed_open] }),
        failed_closed: pct(raw.scan_failed_closed, turns, { hiddenIfAny: [cells.scan_failed_closed] }),
        unscanned_external: pct(unscannedExternal, turns, { hiddenIfAny: [cells.unscanned, cells.scan_failed_open] }),
    };

    if (!kindsActive) {
        out.kinds = { status: 'off' };
    } else if (employee && !(Number(contributors) >= K.kinds)) {
        out.kinds = { status: 'suppressed', k: K.kinds };
    } else {
        /** @type {Record<string, number>} */
        const flat = {};
        for (const r of (kindRows || []).filter(mine)) {
            if (!KINDS.includes(r.value) || (r.protection !== 'protected' && r.protection !== 'exposed')) continue;
            const key = `${r.value}:${r.protection}`;
            flat[key] = (flat[key] || 0) + (Number(r.turns) || 0);
        }
        const shown = suppressCells(flat);
        /** @type {Record<string, {protected: Cell, exposed: Cell}>} */
        const byKind = {};
        for (const kind of KINDS) {
            const p = flat[`${kind}:protected`] || 0;
            const e = flat[`${kind}:exposed`] || 0;
            if (!p && !e) continue;
            byKind[kind] = { protected: shown[`${kind}:protected`] ?? 0, exposed: shown[`${kind}:exposed`] ?? 0 };
        }
        out.kinds = { status: 'shown', rows: byKind };
    }
    return out;
}

/** Turn a shown cell into words for a check's details. @param {Cell|null} v */
function cellWords(v) {
    if (v === '<5') return 'fewer than 5';
    if (v === 'hidden') return 'hidden';
    if (v === null || v === undefined) return 'n/a';
    return String(v);
}

module.exports = {
    band,
    contributorBand,
    suppressCells,
    pct,
    windowFor,
    lastFourWeeks,
    surfaceFigures,
    periodStart,
    cellWords,
    utcDay,
    addDays,
    isoMonday,
    mondayOnOrAfter,
};
