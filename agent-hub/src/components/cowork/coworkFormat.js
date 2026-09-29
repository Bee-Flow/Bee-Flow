/**
 * Time formatting for the Cowork surface.
 *
 * Lives here rather than in each view because the list, the detail header and
 * the run history all state the same three things — how long ago, how long it
 * took, and exactly when — and they used to word them differently.
 *
 * CW-16 rewrote two of the three. What changed, and why:
 *
 *   - `fullTimestamp` said "Aug 13, 11:29 AM" on an en-US browser. Three
 *     things wrong with that in a history list: the reader has to decode a
 *     date to answer "was that this morning?", the clock was 12-hour in a
 *     product whose schedules are all written as 08:00, and the month-first
 *     order came from the BROWSER's locale rather than the workspace's — a
 *     Dutch workspace on a US laptop got an American date.
 *   - `formatDuration` changed unit as it grew: 820ms → "820ms", 5.2s →
 *     "5.2s", 127s → "2m 7s". Three shapes of three different widths in one
 *     64px column, none of them lining up, and "0m 48s" — the shape the
 *     design asks for — impossible to produce.
 *
 * `relativeTime` is deliberately untouched: the list column (CoworkRow) is
 * its only reader and it says something else — "how long ago", not "when".
 */

/** "just now" / "12m ago" / "3h ago" / "2d ago" / "5w ago". */
export function relativeTime(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
}

/**
 * "0m 48s" / "1m 04s" / "2m 07s" — always minutes AND seconds, seconds always
 * two digits (CW-16).
 *
 * One shape for every duration, because these are read in a column: a fixed
 * pair of numbers can be compared down the page at a glance, where a column
 * mixing "820ms", "5.2s" and "2m 7s" has to be parsed line by line.
 *
 * `m` and `s` are the SI symbols, not English words — Dutch, German and French
 * spell minutes and seconds with the same two letters — so this needs no
 * translation hook and gets none. A dictionary key here would invite a
 * translator to "fix" a symbol that is already correct in their language.
 *
 * Rounding happens ONCE, to whole seconds, before the split. The old code
 * rounded the remainder after flooring the minutes, which could print "1m 60s"
 * and "60.0s" — values that do not exist. Under a second rounds to "0m 00s":
 * a run that took 300ms took, to the nearest second this column shows, no
 * time at all. A missing duration is still the empty string, which is a
 * different statement ("we did not measure") and must stay distinguishable.
 *
 * A negative duration is clock skew, never a fact about the run, so it clamps
 * to zero rather than printing "-0m 05s" at the user.
 */
export function formatDuration(ms) {
    if (ms == null) return '';
    const numeric = Number(ms);
    if (!Number.isFinite(numeric)) return '';
    const totalSeconds = Math.max(0, Math.round(numeric / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

/** 24-hour wall clock, "08:00" — never an AM/PM the schedules never use. */
function clock(d) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** Midnight-to-midnight distance in whole days; negative for the future. */
function daysApart(then, now) {
    const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((b - a) / 86_400_000);
}

/**
 * When a run happened, in the words someone would use out loud (CW-16):
 * "Today 08:00", "Yesterday 08:00", "Tuesday 08:00", and past that week
 * "13 Aug 08:00" — with the year once it is not this year, because a history
 * list that cannot tell August 2025 from August 2026 is worse than useless
 * on exactly the item you are trying to understand.
 *
 * `t` is optional and second, so a caller with no translator still gets
 * readable English. Only two words are translated: the weekday and month
 * names come from Intl in the reader's own locale, and translating those by
 * hand would mean shipping a second, worse calendar.
 *
 * An unparseable date now yields the empty string. It used to render the
 * literal "Invalid Date" into the row — the try/catch that was meant to
 * prevent that never fired, because toLocaleString does not throw.
 */
export function fullTimestamp(dateStr, t = null, { now = new Date() } = {}) {
    if (!dateStr) return '';
    const d = dateStr instanceof Date ? dateStr : new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';

    const say = (key, fallback) => (typeof t === 'function' ? t(key, fallback) : fallback);
    const time = clock(d);
    const days = daysApart(d, now);

    if (days === 0) return `${say('cowork.history.today', 'Today')} ${time}`;
    if (days === 1) return `${say('cowork.history.yesterday', 'Yesterday')} ${time}`;
    if (days > 1 && days < 7) {
        const weekday = d.toLocaleDateString(undefined, { weekday: 'long' });
        return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${time}`;
    }
    const date = d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear()
        ? { day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' });
    return `${date} ${time}`;
}
