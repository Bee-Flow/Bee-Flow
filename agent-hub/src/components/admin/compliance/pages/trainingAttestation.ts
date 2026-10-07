/**
 * trainingAttestation: the twelve-month clock of a training attestation
 * (TrainingPage). The window IS the personnel clock: it stays quiet (grey)
 * until QUIET_UNTIL_MS is left, and a member carries the attest button only
 * once REATTEST_WINDOW_MS or less is left, or with no attestation at all.
 */

const DAY_MS = 86_400_000;

/** An attestation is good for a year; without one there is no clock, not a red one. */
export const ATTESTATION_MONTHS = 12;

/** The clock draws in neutral ink while more than this is left. */
export const QUIET_UNTIL_MS = 30 * DAY_MS;

/** The button shows from 60 days before the attestation lapses. */
export const REATTEST_WINDOW_MS = 60 * DAY_MS;

export interface AttestedPerson {
    attested_at?: string | null;
}

export function attestationDueAt(person: AttestedPerson | null | undefined, months: number = ATTESTATION_MONTHS): string | null {
    const at = person?.attested_at;
    if (!at) return null;
    const ms = new Date(at).getTime();
    if (Number.isNaN(ms)) return null;
    const d = new Date(ms);
    d.setMonth(d.getMonth() + months);
    return d.toISOString();
}

/** No attestation on record, or 60 days or less left on it. */
export function needsAttestation(person: AttestedPerson | null | undefined, now: number = Date.now()): boolean {
    const due = attestationDueAt(person);
    return !due || new Date(due).getTime() - now <= REATTEST_WINDOW_MS;
}
