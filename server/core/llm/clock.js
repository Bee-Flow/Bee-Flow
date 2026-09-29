// @typecheck
/**
 * The one clock every prompt reads from.
 *
 * Every chat surface tells the model what time it is. Until 2026-09 each
 * surface carried its own copy of the same IIFE, and all of them printed
 * SECONDS. A prompt that changes every second can never be a cache hit: on
 * the hosted providers the block simply sat in the volatile half, but on a
 * self-hosted llama.cpp server the prompt cache is a byte-prefix match, and
 * a line that differs on every request means the whole prompt is re-read
 * (measured 2026-09-11: 4,375 tokens / 28.7 s per turn at ~150 tok/s).
 *
 * Minute resolution is the compromise: two requests inside the same minute
 * produce byte-identical text, and no model needs to know the seconds.
 *
 * Format: `YYYY-MM-DD HH:MM UTC±HH:MM (Area/City)` — the ISO-like `sv-SE`
 * date order the surfaces already used, the explicit offset so the model can
 * do arithmetic against UTC timestamps in tool results, and the zone name so
 * it knows which local calendar applies.
 */

const DEFAULT_TZ = 'Europe/Amsterdam';

/**
 * `+02:00`-style offset of `tz` at instant `now`.
 *
 * The clones did `new Date(now.toLocaleString('en-US', { timeZone: tz }))`
 * and diffed that against `now`. That re-parses the zone's wall time in the
 * PROCESS zone, so it only ever measured `offset(tz) - offset(process)` —
 * correct inside a UTC container, and `UTC+00:00 (Europe/Amsterdam)` on a
 * developer box running in Amsterdam. Reading the wall-clock fields through
 * Intl and rebuilding them with Date.UTC measures the zone alone.
 *
 * Throws on an unknown zone, so callers that must not throw go through
 * formatLocalNow.
 */
function utcOffsetMinutes(now, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now);
    const field = (type) => Number(parts.find(p => p.type === type).value);
    const wallAsUtc = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour') % 24, field('minute'), field('second'));
    // `now` carries milliseconds the wall clock does not; rounding to whole
    // minutes absorbs that (offsets are whole minutes everywhere on Earth).
    return Math.round((wallAsUtc - now.getTime()) / 60000);
}

function utcOffsetString(now = new Date(), tz = DEFAULT_TZ) {
    const offsetMin = utcOffsetMinutes(now, tz);
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function formatIn(tz, now) {
    const datePart = new Intl.DateTimeFormat('sv-SE', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23',
    }).format(now);
    return `${datePart} UTC${utcOffsetString(now, tz)} (${tz})`;
}

/**
 * Local wall-clock time at minute resolution.
 *
 * @param {string} [tz] IANA zone; empty/invalid falls back to the product
 *   default, then to UTC — never throws, because this runs inside prompt
 *   assembly where a client-supplied zone string is not worth a 500.
 * @param {{ now?: Date }} [opts] `now` is injectable so tests can pin the
 *   instant and prove two calls in one minute agree byte for byte.
 */
function formatLocalNow(tz = DEFAULT_TZ, { now = new Date() } = {}) {
    const zone = (typeof tz === 'string' && tz.trim()) ? tz.trim() : DEFAULT_TZ;
    try {
        return formatIn(zone, now);
    } catch (_) {
        // Unknown zone (RangeError from Intl). The default is a real zone, so
        // the second attempt only fails on a broken ICU build.
        try {
            return formatIn(DEFAULT_TZ, now);
        } catch (__) {
            return `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC+00:00 (UTC)`;
        }
    }
}

/** The prompt line itself, so no surface spells the prefix differently. */
function nowLine(tz, opts) {
    return `Now: ${formatLocalNow(tz, opts)}`;
}

module.exports = { formatLocalNow, utcOffsetString, nowLine, DEFAULT_TZ };
