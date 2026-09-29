/**
 * Formatting shared by the Record tab and the meeting detail screen.
 *
 * Kept in one file because the same numbers are rendered in three places and
 * a meeting that reads "1:05:30" on the list and "65:30" in the transcript
 * looks like two different recordings.
 */

/**
 * "8:04" under an hour, "1:05:30" over it. Never "65:30".
 *
 * NOT the shared helper, and deliberately not merged with the `formatDuration`
 * in features/automate/format.ts, which the de-duplication pass looked at and
 * left alone. They take different units and render different shapes, and both
 * are right for what they label:
 *
 *   - This one takes SECONDS and renders a clock, because it labels media. It
 *     is a meeting's length in a list, and it is also the seek position of a
 *     transcript segment (TranscriptTurn renders `formatDuration(segment.start)`
 *     as a timecode) — and a timecode is a clock or it is not a timecode.
 *   - The automate one takes MILLISECONDS and renders a spoken elapsed
 *     ("0.4s", "3m 04s"), because it labels how long a step took. Sub-second
 *     resolution is the interesting part there, and this function would render
 *     every fast run as "0:00".
 *
 * Zero is "0:00" here rather than the automate copy's em dash, for the same
 * reason: a recording of no length is a real, if broken, recording, and a clock
 * that reads 0:00 says that. A run with no duration has not started.
 */
export function formatDuration(seconds: number | null | undefined): string {
    if (!seconds || seconds < 0 || !Number.isFinite(seconds)) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The live timer. Zero-padded minutes so the digits do not shift width as the
 * recording passes ten minutes — a timer that jitters looks unreliable, and
 * this one is the main thing on screen for an hour at a time.
 */
export function formatElapsed(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "Today 14:05", "Yesterday 09:12", "12 Mar", "12 Mar 2025". */
export function formatWhen(iso: string | null | undefined): string {
    if (!iso) return '';
    const then = new Date(iso);
    const time = then.getTime();
    if (Number.isNaN(time)) return '';

    const now = new Date();
    const sameDay = (a: Date, b: Date) =>
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();

    const clock = then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (sameDay(then, now)) return `Today ${clock}`;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(then, yesterday)) return `Yesterday ${clock}`;

    return then.toLocaleDateString(
        undefined,
        then.getFullYear() === now.getFullYear()
            ? { day: 'numeric', month: 'short' }
            : { day: 'numeric', month: 'short', year: 'numeric' },
    );
}

/**
 * The speaker palette, copied from agent-hub/src/config/meetingNotesConfig.ts
 * so a colleague is the same colour on the phone as on the desktop.
 *
 * Assigned by RANK (most airtime first), never by hashing the name: a rename
 * would otherwise recolour the whole transcript, and two speakers could
 * collide. Everyone past the palette shares the neutral grey — deliberately
 * not modulo-cycled, because giving two people the same colour is the exact
 * ambiguity ranking removes.
 */
export const SPEAKER_COLORS = [
    '#3b82f6',
    '#ec4899',
    '#f59e0b',
    '#10b981',
    '#06b6d4',
    '#8b5cf6',
    '#ef4444',
    '#f97316',
    '#84cc16',
    '#6366f1',
] as const;

export const NEUTRAL_SPEAKER_COLOR = '#94a3b8';

/** name → colour, built once per note from the speaker rows in rank order. */
export function buildSpeakerColors(
    speakers: { id: string; speakingSeconds?: number }[],
): Record<string, string> {
    const ranked = [...speakers].sort(
        (a, b) => (b.speakingSeconds ?? 0) - (a.speakingSeconds ?? 0),
    );
    const map: Record<string, string> = {};
    ranked.forEach((speaker, index) => {
        map[speaker.id] = SPEAKER_COLORS[index] ?? NEUTRAL_SPEAKER_COLOR;
    });
    return map;
}

/** A default meeting title: the thing a person would have typed anyway. */
export function defaultMeetingTitle(at: Date = new Date()): string {
    return `Meeting ${at.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
    })} ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
