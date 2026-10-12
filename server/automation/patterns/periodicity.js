// @typecheck
'use strict';
/**
 * Periodicity: how regularly something happens.
 *
 * cadenceOf(timestamps, { now, windowDays, historyDays, timeZone, tzOffsetMinutes })
 * classifies on the gaps between DISTINCT days (several events on one day are
 * one occurrence of the habit), their coefficient of variation, the share of
 * weekend days and the weekday/hour concentration.
 *
 * perMonth is normalised by the effective window: the smaller of windowDays
 * and how much history exists, so a two-week-old account is not divided by 90.
 *
 * Local time. The weekday, the hour band and the calendar days are the
 * VIEWER's: "Mon 09–10" on a card, and the schedule hint the builder gets,
 * must be the hours the person keeps, not UTC's. `timeZone` is an IANA zone
 * (the browser's, sent with the scan); its offset is looked up per hour, so a
 * daylight-saving change inside the window moves nothing. `tzOffsetMinutes`
 * is a fixed offset for callers without a zone. With neither, or with a zone
 * this runtime does not know, everything is counted in UTC.
 *
 * Pure: no I/O.
 */

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const HOUR = 3_600_000;

/** One formatter per zone (building one is the slow part); null for an unknown zone. */
/** @type {Map<string, Intl.DateTimeFormat|null>} */
const ZONE_FORMATS = new Map();

/** @param {string} tz */
function zoneFormat(tz) {
    if (!ZONE_FORMATS.has(tz)) {
        let f = null;
        try {
            f = new Intl.DateTimeFormat('en-US', {
                timeZone: tz, hourCycle: 'h23',
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
            });
        } catch (_) { f = null; }
        ZONE_FORMATS.set(tz, f);
    }
    return ZONE_FORMATS.get(tz) ?? null;
}

/** Whether `tz` is an IANA zone this runtime can convert to. @param {unknown} tz */
function isTimeZone(tz) {
    return typeof tz === 'string' && tz.length > 0 && tz.length <= 64 && zoneFormat(tz) !== null;
}

/** Offsets already looked up, by `zone|hour since epoch`. Bounded: cleared when full. */
/** @type {Map<string, number>} */
const OFFSETS = new Map();
const MAX_OFFSETS = 50_000;

/**
 * Minutes `tz` is ahead of UTC at instant `t` (Europe/Amsterdam in July: 120).
 * The wall-clock fields are read through Intl and rebuilt with Date.UTC, so
 * the process's own zone plays no part. 0 for an unknown zone.
 * @param {number} t epoch ms
 * @param {string} tz
 */
function zoneOffsetMinutes(t, tz) {
    const f = zoneFormat(tz);
    if (!f) return 0;
    const key = `${tz}|${Math.floor(t / HOUR)}`;
    const hit = OFFSETS.get(key);
    if (hit !== undefined) return hit;
    /** @type {Record<string, number>} */
    const p = {};
    for (const part of f.formatToParts(new Date(t))) p[part.type] = Number(part.value);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
    const offset = Math.round((wall - Math.floor(t / 60_000) * 60_000) / 60_000);
    if (OFFSETS.size >= MAX_OFFSETS) OFFSETS.clear();
    OFFSETS.set(key, offset);
    return offset;
}

/**
 * t → the same instant as "local wall-clock ms", read with getUTC*.
 * @param {{ timeZone?: string|null, tzOffsetMinutes?: number }} opts
 * @returns {(t: number) => number}
 */
function localClock(opts) {
    const tz = opts.timeZone;
    if (typeof tz === 'string' && isTimeZone(tz)) return (t) => t + zoneOffsetMinutes(t, tz) * 60_000;
    const shift = (Number.isFinite(opts.tzOffsetMinutes) ? Number(opts.tzOffsetMinutes) : 0) * 60_000;
    return (t) => t + shift;
}

/** @param {number[]} xs */
function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** @param {number[]} xs */
function coefficientOfVariation(xs) {
    if (xs.length < 2) return 0;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (mean === 0) return 0;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    return Math.sqrt(variance) / mean;
}

/**
 * The tightest 1- or 2-hour band holding at least 60% of the events.
 * @param {number[]} hours
 * @returns {[number, number]|undefined}
 */
function hourBandOf(hours) {
    if (hours.length < 3) return undefined;
    const hist = new Array(24).fill(0);
    for (const h of hours) hist[h]++;
    const need = hours.length * 0.6;
    let best = -1;
    for (let h = 0; h < 24; h++) if (best < 0 || hist[h] > hist[best]) best = h;
    if (hist[best] >= need) return [best, best + 1];
    let bestPair = -1;
    let bestPairCount = -1;
    for (let h = 0; h < 23; h++) {
        const c = hist[h] + hist[h + 1];
        if (c > bestPairCount) { bestPair = h; bestPairCount = c; }
    }
    if (bestPairCount >= need) return [bestPair, bestPair + 2];
    return undefined;
}

/**
 * @typedef {{
 *   kind: 'daily'|'weekdays'|'weekly'|'biweekly'|'monthly'|'irregular',
 *   weekday?: number, hourBand?: [number, number], cv: number,
 *   distinctDays: number, weeksPresent: number, weeksWindow: number,
 *   recentWeeks: number, monthsPresent: number, monthsWindow: number,
 *   perMonth: number, weekdayHistogram: number[], medianGapDays: number,
 *   lastTs: number|null
 * }} Cadence
 */

/**
 * @param {number[]} timestamps epoch ms
 * @param {{ now?: number, windowDays?: number, historyDays?: number, timeZone?: string|null, tzOffsetMinutes?: number }} [opts]
 * @returns {Cadence}
 */
function cadenceOf(timestamps, opts = {}) {
    const now = opts.now ?? Date.now();
    const windowDays = opts.windowDays ?? 90;
    const local = localClock(opts);
    const effectiveDays = Math.max(1, Math.min(windowDays, opts.historyDays ?? windowDays));
    const since = now - windowDays * DAY;
    const ts = (timestamps || []).filter((t) => Number.isFinite(t) && t >= since && t <= now).sort((a, b) => a - b);

    const weekdayHistogram = new Array(7).fill(0);
    const hours = [];
    const dayKeys = new Set();
    const weekKeys = new Set();
    const monthKeys = new Set();
    const recentWeekKeys = new Set();
    let weekend = 0;
    for (const t of ts) {
        const lt = local(t);
        const d = new Date(lt);
        const wd = d.getUTCDay();
        weekdayHistogram[wd]++;
        hours.push(d.getUTCHours());
        if (wd === 0 || wd === 6) weekend++;
        dayKeys.add(Math.floor(lt / DAY));
        const weekIdx = Math.floor((now - t) / WEEK);
        weekKeys.add(weekIdx);
        if (weekIdx < 6) recentWeekKeys.add(weekIdx);
        monthKeys.add(Math.floor((now - t) / (30 * DAY)));
    }
    const days = [...dayKeys].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
    const cv = Math.round(coefficientOfVariation(gaps) * 100) / 100;
    const medianGapDays = median(gaps);
    const spanDays = days.length ? days[days.length - 1] - days[0] + 1 : 0;
    const coverage = spanDays ? days.length / spanDays : 0;
    const weekendShare = ts.length ? weekend / ts.length : 0;

    // Dominant weekday: at least half the occurrences on one day of the week.
    let topWd = 0;
    for (let i = 1; i < 7; i++) if (weekdayHistogram[i] > weekdayHistogram[topWd]) topWd = i;
    const weekdayShare = ts.length ? weekdayHistogram[topWd] / ts.length : 0;

    // Share of the occurrences on the three busiest weekdays: a Mon/Wed/Fri
    // habit is weekly on fixed days, not irregular.
    const top3Share = ts.length ? [...weekdayHistogram].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0) / ts.length : 0;
    const spanWeeks = Math.max(1, Math.ceil(spanDays / 7));

    /** @type {Cadence['kind']} */
    let kind = 'irregular';
    if (days.length >= 3) {
        if (medianGapDays <= 1.5 && coverage >= 0.5) {
            kind = weekendShare < 0.1 ? 'weekdays' : 'daily';
        } else if (medianGapDays > 1.5 && medianGapDays < 5 && cv <= 0.6 && top3Share >= 0.85
            && weekKeys.size >= spanWeeks * 0.75) {
            kind = 'weekly';
        } else if (medianGapDays >= 5 && medianGapDays <= 9 && cv <= 0.6) {
            kind = 'weekly';
        } else if (medianGapDays >= 12 && medianGapDays <= 17 && cv <= 0.5) {
            kind = 'biweekly';
        } else if (medianGapDays >= 25 && medianGapDays <= 35 && cv <= 0.35) {
            kind = 'monthly';
        }
    }

    // Weeks are 7-day buckets back from now. An event exactly `effectiveDays`
    // ago opens one bucket more than the window holds; "4 of 3 weeks" is
    // never the right thing to show.
    const weeksWindow = Math.max(1, Math.ceil(effectiveDays / 7));

    /** @type {Cadence} */
    const out = {
        kind,
        cv,
        distinctDays: days.length,
        weeksPresent: Math.min(weekKeys.size, weeksWindow),
        weeksWindow,
        recentWeeks: recentWeekKeys.size,
        monthsPresent: monthKeys.size,
        monthsWindow: Math.max(1, Math.round(effectiveDays / 30)),
        perMonth: Math.round((ts.length / effectiveDays) * 30 * 10) / 10,
        weekdayHistogram,
        medianGapDays,
        lastTs: ts.length ? ts[ts.length - 1] : null,
    };
    if ((kind === 'weekly' || kind === 'biweekly' || kind === 'monthly') && weekdayShare >= 0.5) out.weekday = topWd;
    const band = hourBandOf(hours);
    if (band) out.hourBand = band;
    return out;
}

module.exports = { cadenceOf, median, coefficientOfVariation, isTimeZone, zoneOffsetMinutes, DAY, WEEK };
