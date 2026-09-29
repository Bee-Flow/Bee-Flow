/**
 * calendarMath — the date arithmetic behind the regulatory calendar
 * (Compliance Center redesign, Sep 2026; artboard 1e "Regelgevingskalender"
 * and the 1a "Komende data" card).
 *
 * `GET /calendar` returns milestones with a `date` ('YYYY-MM-DD', or null
 * when the item is `kind: 'uncertain'`) and leaves the TODAY marker to the
 * client — the server does not know the reader's clock or time zone. So the
 * client splits the list on its own midnight:
 *
 *   past      date before today          → oldest first, greyed
 *   upcoming  date today or later        → nearest first (same day counts
 *                                          as upcoming: a deadline that falls
 *                                          today is not yet history)
 *   uncertain no date, or kind uncertain → the "Nog onzeker" footer
 *
 * A 'YYYY-MM-DD' is parsed as LOCAL midnight on purpose: `new Date('2026-12-02')`
 * is UTC midnight, which in Amsterdam is still 1 Dec at 23:00 in winter — off
 * by one on every date the calendar shows. Anything unparseable is
 * `uncertain`, never a throw.
 *
 * Distances are whole days between local midnights; beyond 90 days the copy
 * switches to months ("over 4 maanden"), and 90 days is also where the
 * warning ink starts (the AI Act Art. 50 transition end at 79 days is orange,
 * the Data Act date at 120 is not).
 *
 * Pure and React-free; RegulatoryCalendar.jsx renders it, and the Overview
 * card and the Frameworks page share the same split.
 */

export const DAY_MS = 86_400_000;

/** Days at or under which a milestone counts as "soon" (warning ink, day units). */
export const SOON_DAYS = 90;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight of the day `ms` falls in. */
export function startOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * A milestone date as local-midnight ms. Accepts 'YYYY-MM-DD' (the contract),
 * a Date, an ISO datetime or an epoch number; null for anything else.
 */
export function parseDay(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') {
        const m = ISO_DAY.exec(value.trim());
        if (m) {
            const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            // '2026-13-45' would roll over into 2027; a date that does not
            // round-trip is not a date.
            if (Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
            return d.getTime();
        }
    }
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? startOfDay(ms) : null;
}

/** `now` as epoch ms: a Date, a number, or anything else → the real clock. */
export function resolveNow(now) {
    if (now === null || now === undefined) return Date.now();
    const ms = now instanceof Date ? now.getTime() : Number(now);
    return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * Whole days from today (local) to the milestone date: negative = past,
 * 0 = today, positive = ahead. Null when the date does not parse.
 */
export function daysUntil(date, now = Date.now()) {
    const target = parseDay(date);
    if (target === null) return null;
    return Math.round((target - startOfDay(resolveNow(now))) / DAY_MS);
}

const isUncertain = (m) => !m || m.kind === 'uncertain' || parseDay(m.date) === null;

/**
 * Split milestones on today. Items keep their identity (no copies); each
 * list is sorted by date ascending, `uncertain` in input order.
 */
export function splitByToday(milestones, now = Date.now()) {
    const past = [];
    const upcoming = [];
    const uncertain = [];
    for (const m of Array.isArray(milestones) ? milestones : []) {
        if (!m || typeof m !== 'object') continue;
        if (isUncertain(m)) { uncertain.push(m); continue; }
        const days = daysUntil(m.date, now);
        (days < 0 ? past : upcoming).push(m);
    }
    const byDate = (a, b) => parseDay(a.date) - parseDay(b.date);
    past.sort(byDate);
    upcoming.sort(byDate);
    return { past, upcoming, uncertain };
}

/**
 * How the distance to an upcoming milestone is worded:
 *   { unit: 'today' }                        the date is today
 *   { unit: 'days',   n, soon: true }        1..90 days
 *   { unit: 'months', n, soon: false }       beyond 90 days, n = rounded months
 * Negative or null input → null (the caller uses daysAgo for the past).
 */
export function countdown(days) {
    if (days === null || days === undefined || !Number.isFinite(days) || days < 0) return null;
    if (days === 0) return { unit: 'today', n: 0, soon: true };
    if (days <= SOON_DAYS) return { unit: 'days', n: days, soon: true };
    return { unit: 'months', n: Math.max(1, Math.round(days / 30.44)), soon: false };
}

/**
 * The BCP-47 tag Intl gets for the app locale. 'en' alone means en-US to
 * ICU ("Dec 2"); every other date in this product is day-first, so plain
 * English formats as en-GB ("2 Dec").
 */
export function intlLocale(locale) {
    if (!locale || typeof locale !== 'string') return 'en-GB';
    return locale === 'en' ? 'en-GB' : locale;
}

/**
 * A milestone date the way the artboard prints it.
 *   year: 'always'  → "2 dec 2026"       (the full calendar column, 80px)
 *   year: 'auto'    → "2 dec" / "12 jan '27" (the compact 78px column: the
 *                     year only when it is not the current one)
 *   year: 'never'   → "2 dec"
 */
export function formatCalDate(date, { locale = 'en', now = Date.now(), year = 'always' } = {}) {
    const ms = parseDay(date);
    if (ms === null) return '';
    const tag = intlLocale(locale);
    const d = new Date(ms);
    let fmt;
    try {
        if (year === 'always') {
            fmt = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric' });
        } else {
            fmt = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' });
        }
    } catch {
        fmt = new Intl.DateTimeFormat('en-GB', year === 'always'
            ? { day: 'numeric', month: 'short', year: 'numeric' }
            : { day: 'numeric', month: 'short' });
    }
    // ICU appends a period to some abbreviated months ("dec.", "Dez.");
    // the artboard column has none. Only the period after LETTERS goes —
    // the German day ordinal ("2. Dez") keeps its own.
    let out = fmt.formatToParts(d)
        .map(part => (part.type === 'month' ? englishMonth(tag, part.value, d) : part.value))
        .join('')
        .replace(/(?<=\p{L})\.(?=\s|$)/gu, '');
    if (year === 'auto' && d.getFullYear() !== new Date(resolveNow(now)).getFullYear()) {
        out += ` '${String(d.getFullYear()).slice(-2)}`;
    }
    return out;
}

/**
 * English abbreviated months are THREE letters in this product ("14 Sep
 * 2026"). ICU's en-GB — which we use for day-first order — spells one of
 * them "Sept", the only four-letter abbreviation in the set; newer ICU
 * versions differ from older ones on exactly this, so a test on one machine
 * printed "Sep" and the same test on another "Sept". Taking the month from
 * en-US (always three letters) pins it. Other locales keep their own word.
 */
const EN_US_MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });
function englishMonth(tag, value, d) {
    if (!/^en(-|$)/i.test(tag)) return value;
    return EN_US_MONTH.format(d);
}
