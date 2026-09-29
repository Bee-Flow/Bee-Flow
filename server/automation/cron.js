/**
 * Minimal cron parser & "next run" computer for automation schedules.
 *
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week.
 * Per-field syntax:
 *   *           any
 *   N           literal
 *   N-M         range
 *   N,M,...     list
 *   ../STEP     step
 *
 * Months are 1-12, day-of-week 0-6 (0 = Sunday). 7 is also accepted as Sunday.
 *
 * Timezone: nextRunAt is computed in the supplied IANA timezone, converted
 * back to UTC for storage. We use Intl.DateTimeFormat tricks rather than
 * adding a new dep — accuracy is "to the minute", which is fine for cron.
 */

function parseField(field, min, max) {
    const out = new Set();
    if (field === '*') {
        for (let i = min; i <= max; i++) out.add(i);
        return out;
    }
    for (const part of field.split(',')) {
        const m = part.match(/^([0-9]+|\*)(?:-([0-9]+))?(?:\/([0-9]+))?$/);
        if (!m) throw new Error(`Invalid cron field: ${part}`);
        const a = m[1] === '*' ? min : parseInt(m[1], 10);
        const b = m[2] !== undefined ? parseInt(m[2], 10) : (m[1] === '*' ? max : a);
        const step = m[3] !== undefined ? parseInt(m[3], 10) : 1;
        if (step < 1) throw new Error('Step must be >= 1');
        for (let v = a; v <= b; v += step) {
            if (v < min || v > max) continue;
            out.add(v);
        }
    }
    return out;
}

function parseCron(cron) {
    const f = cron.trim().split(/\s+/);
    if (f.length !== 5) throw new Error(`Cron must have 5 fields, got ${f.length}`);
    const [minute, hour, dom, month, dow] = f;
    const fields = {
        minute: parseField(minute, 0, 59),
        hour:   parseField(hour, 0, 23),
        dom:    parseField(dom, 1, 31),
        month:  parseField(month, 1, 12),
        dow:    parseField(dow, 0, 7),
    };
    if (fields.dow.has(7)) { fields.dow.delete(7); fields.dow.add(0); }
    return fields;
}

// Constructing an Intl.DateTimeFormat is expensive (~tens of µs). nextRunAt
// calls partsInTz up to 366*1440 ≈ 527k times per scan, ALWAYS with the same
// tz — building a fresh formatter each time froze the event loop for 16-19s on
// a pathological cron (e.g. "0 0 31 2 *"), a single-request DoS reachable via
// POST /_schedule/preview. Cache one formatter per timezone instead.
const _fmtCache = new Map();
function formatterForTz(tz) {
    let fmt = _fmtCache.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
            hour12: false, weekday: 'short',
        });
        _fmtCache.set(tz, fmt);
    }
    return fmt;
}

/**
 * Get the calendar parts (Y/M/D/h/m/dow) of a UTC timestamp viewed in `tz`.
 */
function partsInTz(ts, tz) {
    const parts = formatterForTz(tz).formatToParts(new Date(ts));
    const o = {};
    for (const p of parts) o[p.type] = p.value;
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        year: parseInt(o.year, 10),
        month: parseInt(o.month, 10),
        day: parseInt(o.day, 10),
        hour: parseInt(o.hour === '24' ? '0' : o.hour, 10),
        minute: parseInt(o.minute, 10),
        dow: dowMap[o.weekday],
    };
}

/**
 * Convert a (year, month, day, hour, minute) wall-clock value in tz into
 * a UTC Date. We invert through UTC by binary-searching offsets — simple
 * and DST-safe to within ±60s, which we tolerate.
 */
function tzWallClockToUtc(year, month, day, hour, minute, tz) {
    // Initial guess: treat the wall time as UTC.
    let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    for (let i = 0; i < 4; i++) {
        const p = partsInTz(guess, tz);
        const wantTs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
        const gotTs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
        const drift = wantTs - gotTs;
        if (drift === 0) break;
        guess += drift;
    }
    return new Date(guess);
}

/**
 * Does the CALENDAR DAY match? (month + day-of-month + day-of-week only.)
 *
 * Split out of the old all-fields `matches()` so nextRunAt can decide per DAY
 * whether it is worth descending into that day's minutes at all — see the
 * comment on nextRunAt. The hour/minute fields are checked by the descent.
 */
function dayMatches(fields, parts) {
    return fields.month.has(parts.month) &&
        // POSIX-cron rule: if both dom and dow are restricted (not '*'),
        // either matching is sufficient. We can't easily detect '*' from
        // the Set, so we approximate: when both have <full size, OR.
        (fields.dom.size === 31 && fields.dow.size === 7
            ? fields.dom.has(parts.day) && fields.dow.has(parts.dow)
            : fields.dom.size === 31
                ? fields.dow.has(parts.dow)
                : fields.dow.size === 7
                    ? fields.dom.has(parts.day)
                    : (fields.dom.has(parts.day) || fields.dow.has(parts.dow)));
}

/**
 * The FIRST UTC instant at which a given wall-clock MINUTE occurs in `tz`,
 * or null when that wall time does not exist. The DST edges are the
 * interesting cases:
 *
 *   - spring forward: the wall time does not exist at all (02:30 on the
 *     switch day in Europe/Amsterdam). Returns null — the old minute-walker
 *     never saw such a minute either, so a schedule pinned inside the gap
 *     skips that day. Semantics preserved.
 *   - fall back: the wall time happens TWICE. tzWallClockToUtc's drift search
 *     lands on whichever occurrence its guess converges to — usually the
 *     LATER one, which made the routine fire an hour late on the switch day,
 *     and in zones that switch at midnight (America/Santiago) it could even
 *     return an instant in the PAST, i.e. a next_run_at the scheduler claims
 *     immediately. We normalise to the EARLIER occurrence, so the rule is
 *     simply: a wall-clock minute fires once per day, at its first
 *     occurrence. (The repeated hour therefore does not fire twice — the old
 *     code dropped one of the two passes as well, it just dropped the early
 *     one and ran late.)
 */
function firstWallClockOccurrence(year, month, day, hour, minute, tz) {
    const isWallTime = (ts) => {
        const p = partsInTz(ts, tz);
        return p.year === year && p.month === month && p.day === day
            && p.hour === hour && p.minute === minute;
    };
    const base = tzWallClockToUtc(year, month, day, hour, minute, tz).getTime();
    if (!isWallTime(base)) return null;
    // Shift sizes actually used by IANA zones (1h almost everywhere, 30min for
    // Lord Howe, 2h for a handful of historical/antarctic zones). Probing
    // BACKWARDS is enough to normalise: if `base` is already the earlier
    // occurrence no probe matches and we keep it.
    for (const shiftMinutes of [60, 30, 120]) {
        const earlier = base - shiftMinutes * 60_000;
        if (isWallTime(earlier)) return earlier;
    }
    return base;
}

/**
 * Compute the next time after `fromTs` (epoch ms, default = now) when the
 * cron expression fires, returning an ISO string in UTC.
 *
 * Day-level scan, capped at 366 days lookahead. The month/day-of-month/
 * day-of-week fields are evaluated ONCE PER CALENDAR DAY using plain UTC
 * calendar arithmetic (no Intl at all); only a day that actually matches is
 * descended into, and the descent asks for the UTC instant of a specific wall
 * clock rather than probing every minute.
 *
 * This replaces a minute-by-minute walk that called partsInTz — and therefore
 * Intl.DateTimeFormat.formatToParts — up to 366*1440 ≈ 527k times, all
 * synchronously on the request thread. A single POST /_schedule/preview for a
 * sparse cron ("0 0 1 1 *", count=20) blocked the Node event loop for ~64
 * seconds; the whole process served nothing for that entire minute. Now it is
 * ~367 arithmetic day checks plus a handful of Intl calls for the one day we
 * descend into.
 *
 * `opts.skipDate(year, month, day)` (optional) leaves out whole calendar days
 * of `tz`: a day it answers true for is never descended into, so the answer is
 * the first match on a day it lets through. This is how a schedule skips
 * public holidays (automation/holidays.js) without a second scan. The 366-day
 * horizon is unchanged; a filter that rejects every matching day yields null.
 */
function nextRunAt(cron, tz = 'Europe/Amsterdam', fromTs = Date.now(), opts = undefined) {
    const fields = parseCron(cron);
    const skipDate = typeof opts?.skipDate === 'function' ? opts.skipDate : null;
    const limit = fromTs + 366 * 24 * 60 * 60 * 1000;
    // Same start point the minute-walker used: the next whole minute, strictly
    // after `fromTs`.
    const startTs = Math.floor(fromTs / 60_000) * 60_000 + 60_000;
    const start = partsInTz(startTs, tz);

    const hours = [...fields.hour].sort((a, b) => a - b);
    const minutes = [...fields.minute].sort((a, b) => a - b);
    // Only the FIRST day can be partly behind us; every later day is scanned
    // from 00:00.
    const firstDayFloor = start.hour * 60 + start.minute;

    // Walk the calendar days of `tz`. Date.UTC arithmetic on the local
    // calendar date yields the next date and its weekday without a second
    // Intl call — a UTC-midnight timestamp has the weekday of that date.
    let dayCursor = Date.UTC(start.year, start.month - 1, start.day);
    // 367 covers the 366-day window plus the partial first/last local day; the
    // real cut-off is the `>= limit` check below.
    for (let dayIndex = 0; dayIndex <= 367; dayIndex++, dayCursor += 86_400_000) {
        const d = new Date(dayCursor);
        const year = d.getUTCFullYear();
        const month = d.getUTCMonth() + 1;
        const day = d.getUTCDate();
        if (!dayMatches(fields, { month, day, dow: d.getUTCDay() })) continue;
        if (skipDate && skipDate(year, month, day)) continue;

        const floor = dayIndex === 0 ? firstDayFloor : 0;
        for (const hour of hours) {
            if (hour * 60 + 59 < floor) continue;
            for (const minute of minutes) {
                if (hour * 60 + minute < floor) continue;
                const ts = firstWallClockOccurrence(year, month, day, hour, minute, tz);
                // null = this wall time is inside a DST spring-forward gap;
                // `< startTs` = it already happened (only reachable on the
                // first day, and inside a fall-back's repeated hour).
                if (ts === null || ts < startTs) continue;
                // Candidates are produced in ascending order, so the first one
                // past the horizon means there is nothing inside it.
                if (ts >= limit) return null;
                return new Date(ts).toISOString();
            }
        }
    }
    return null;
}

module.exports = { parseCron, nextRunAt, partsInTz };
