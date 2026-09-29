/**
 * How long ago something happened, in the app's one voice.
 *
 * This existed six times before this file did: once in each of
 * `features/{automate,library,notifications,search,settings}/format.ts` and
 * once inline at the bottom of `app/(tabs)/index.tsx`. Three of those copies
 * were byte-identical, and the other three had quietly drifted — `search`
 * rounded where the rest floored (so 89 seconds read as "1m" in one list and
 * "1m" in another but 91 minutes read as "2h" here and "1h" there), and
 * `notifications` returned "5m ago" where everybody else returned "5m".
 *
 * That last difference is the one that actually reached the screen. Five call
 * sites wrote `` `started ${relativeTime(x)} ago` `` against the terse form,
 * which renders "started now ago" for anything under a minute — the exact case
 * a run list shows most often, because the row you are looking at is usually
 * the one that just started.
 *
 * So the suffix is a parameter rather than a fork. A caller that wants a bare
 * meta-slot token asks for nothing; a caller that wants a sentence asks for
 * `{ suffix: true }` and gets "just now", not "now ago".
 */

export interface RelativeTimeOptions {
    /**
     * Render as a phrase: "just now", "5m ago", "3d ago". Without it the
     * result is a bare token fit for a list row's meta slot: "now", "5m", "3d".
     *
     * Either way, anything older than a week becomes an absolute date — "12 Mar"
     * is both shorter and more useful than "38d", and a date does not take
     * "ago".
     */
    suffix?: boolean;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 7 * DAY;

/**
 * `iso` is anything `Date` can parse, or nothing.
 *
 * Missing and unparseable both return an empty string rather than a placeholder:
 * these land in meta slots and subtitles, where "" collapses the row cleanly and
 * "Invalid Date" does not. The caller that needs to distinguish "no timestamp"
 * from "a broken timestamp" has the original value and can say so itself.
 */
export function relativeTime(
    iso: string | null | undefined,
    options: RelativeTimeOptions = {},
): string {
    if (!iso) return '';
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';

    // Clamped at zero: a server clock a few seconds ahead of the device would
    // otherwise produce "-1m", which reads as a bug to the person holding the
    // phone even though it is a bug in the clocks.
    const seconds = Math.max(0, (Date.now() - then) / 1000);
    const ago = options.suffix ? ' ago' : '';

    if (seconds < MINUTE) return options.suffix ? 'just now' : 'now';
    if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m${ago}`;
    if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h${ago}`;
    if (seconds < WEEK) return `${Math.floor(seconds / DAY)}d${ago}`;

    // Floored, not rounded, throughout: "1h" for 119 minutes is what a person
    // means by "an hour ago". Rounding up to "2h" claims more precision than
    // the unit has and reads as wrong when the timestamp is visible elsewhere.
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
