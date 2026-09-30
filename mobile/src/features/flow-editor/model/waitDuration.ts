/**
 * The Wait step's one duration vocabulary — a port of the web builder's
 * flow/waitDuration.js, pinned by labels.lockstep.test.ts. `seconds` stays
 * the stored form; this is display and parsing, in the same unit the editor
 * opens on, so the card and the editor never disagree.
 */

export const WAIT_MIN_SECONDS = 1;
/** 24 hours — the engine's own ceiling (execWait). */
export const WAIT_MAX_SECONDS = 86400;
export const WAIT_UNIT_FACTOR = { seconds: 1, minutes: 60, hours: 3600 } as const;
export type WaitUnit = keyof typeof WAIT_UNIT_FACTOR;

export const clampWaitSeconds = (n: number): number =>
    Math.max(WAIT_MIN_SECONDS, Math.min(WAIT_MAX_SECONDS, Math.round(n)));

/** The largest unit that divides `seconds` exactly — how the editor opens. */
export function waitUnitFor(seconds: number): WaitUnit {
    if (seconds >= 3600 && seconds % 3600 === 0) return 'hours';
    if (seconds >= 60 && seconds % 60 === 0) return 'minutes';
    return 'seconds';
}

const SINGULAR: Record<WaitUnit, string> = { seconds: 'second', minutes: 'minute', hours: 'hour' };

/** "2 hours", "90 seconds", "1 minute"; null for nothing valid. */
export function formatWaitDuration(seconds: unknown): string | null {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return null;
    const unit = waitUnitFor(s);
    const n = s / WAIT_UNIT_FACTOR[unit];
    if (!Number.isInteger(n)) return `${s} second${s === 1 ? '' : 's'}`;
    return `${n} ${SINGULAR[unit]}${n === 1 ? '' : 's'}`;
}
