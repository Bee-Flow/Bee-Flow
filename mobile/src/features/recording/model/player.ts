/**
 * The meeting player's pure rules: speeds, skips, the seek bar's arithmetic,
 * and which duration to believe. Mirrors agent-hub WaveformPlayer.jsx.
 */

/** The web's RATES, in its cycle order. */
export const PLAYBACK_RATES: readonly number[] = [1, 1.25, 1.5, 2];

/** Back / forward, as the web's transport buttons. */
export const SKIP_SECONDS = 10;

export function nextRate(rate: number): number {
    const index = PLAYBACK_RATES.indexOf(rate);
    return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
}

/**
 * The duration to draw against. A stream-recorded WebM carries no duration in
 * its container, so the player can report 0 (or Infinity) for the whole
 * playback; the note's stored `durationSeconds` is exact and wins over that.
 */
export function effectiveDuration(reported: number, stored: number | null | undefined): number {
    if (Number.isFinite(reported) && reported > 0) return reported;
    return stored && stored > 0 ? stored : 0;
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/** 0..1 along the bar for a touch at `x` on a bar `width` wide. */
export function fractionAt(x: number, width: number): number {
    return width > 0 ? clamp(x / width, 0, 1) : 0;
}

/** 0..1 of the way through. */
export function progressOf(current: number, duration: number): number {
    return duration > 0 ? clamp(current / duration, 0, 1) : 0;
}

/** Where a skip lands, kept inside the recording. */
export function skipTarget(current: number, delta: number, duration: number): number {
    const end = duration > 0 ? duration : Number.POSITIVE_INFINITY;
    return clamp(current + delta, 0, end);
}

/** The cache file one note's audio is kept in, so a second play does not download again. */
export function audioCacheName(id: string): string {
    return `meeting-audio-${id}`;
}
