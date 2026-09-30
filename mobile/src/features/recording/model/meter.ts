/**
 * The level meter's arithmetic: dBFS to a bar, the smoothing that makes speech
 * read as speech, and the "is it actually hearing anything?" count. Pure, so
 * the recorder hook only moves samples through it.
 */

/** Samples kept for the meter. 40 × 100ms ≈ the last four seconds. */
export const METER_HISTORY = 40;

/** Consecutive near-silent samples before we say something. ≈4s. */
export const QUIET_SAMPLES = 40;
const QUIET_THRESHOLD = 0.04;

export const SILENT_HISTORY: number[] = new Array<number>(METER_HISTORY).fill(0);

/**
 * dBFS → 0..1.
 *
 * expo-audio reports metering as decibels relative to full scale: 0 is
 * clipping, and anything below about -60 dB is a quiet room. Mapping the
 * bottom 60 dB across the full bar is what makes normal speech sit in the
 * middle of the meter instead of pinned at either end.
 */
export function normaliseMetering(db: number | undefined): number {
    if (db === undefined || Number.isNaN(db)) return 0;
    const floor = -60;
    if (db <= floor) return 0;
    if (db >= 0) return 1;
    return (db - floor) / -floor;
}

/**
 * Asymmetric smoothing: jump to a new peak immediately so a syllable
 * registers, then fall gently. A symmetric filter makes speech look like a
 * slow sine wave, which reads as "not working".
 */
export function smoothLevel(previous: number, raw: number): number {
    return raw > previous ? raw : previous * 0.82 + raw * 0.18;
}

/**
 * Hysteresis, not a threshold test: a natural pause in a conversation is
 * silent for a second or two, and a meter that cries wolf every time someone
 * stops to think teaches people to ignore it. The run resets on any sound.
 */
export function nextQuietRun(run: number, raw: number): number {
    return raw < QUIET_THRESHOLD ? run + 1 : 0;
}
