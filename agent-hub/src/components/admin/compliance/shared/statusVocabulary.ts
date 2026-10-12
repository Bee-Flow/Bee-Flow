/**
 * statusVocabulary: ONE map from a register's lifecycle state to how its
 * status pill looks, for every register of the Compliance Center (requests,
 * incidents, risks, nonconformities, audits, objectives, policies, SoA ...).
 *
 * Before this map, "Open" was red on one register, grey on the next and
 * dashed on a third, and dashed already means "self-attested"
 * (VerificationChip). The pill now says only WHERE in its lifecycle a record
 * is; how URGENT it is stays with the deadline clock and the row's stripe.
 *
 *   neutral  not started yet          new · open · pending · received · planned · active ·
 *                                       draft · todo
 *   warning  someone is working on it  in_progress · treating · assessing · corrective_action ·
 *                                       effectiveness_review · early_warning_sent ·
 *                                       authority_notified · reported · subjects_notified · reviewed
 *   success  done (with a Check glyph)  fulfilled · closed · approved · published · achieved · done ·
 *                                       accepted (a risk accepted on record) · resolved
 *   muted    out of the count           rejected · dropped · excluded · not_applicable ·
 *                                       cancelled · expired · archived
 *
 * There is no dashed tone and no error tone: a state is not an alarm.
 * An unknown state is neutral.
 */

export type RegisterStateTone = 'neutral' | 'warning' | 'success' | 'muted';

const NEUTRAL = ['new', 'open', 'pending', 'received', 'planned', 'active', 'draft', 'todo'] as const;
const WARNING = [
    'in_progress', 'treating', 'assessing', 'corrective_action', 'effectiveness_review',
    'early_warning_sent', 'authority_notified', 'reported', 'subjects_notified', 'reviewed',
] as const;
const SUCCESS = ['fulfilled', 'closed', 'approved', 'published', 'achieved', 'done', 'accepted', 'resolved'] as const;
const MUTED = ['rejected', 'dropped', 'excluded', 'not_applicable', 'cancelled', 'expired', 'archived'] as const;

export const REGISTER_STATE_TONES: Readonly<Record<string, RegisterStateTone>> = Object.freeze({
    ...Object.fromEntries(NEUTRAL.map((s) => [s, 'neutral' as const])),
    ...Object.fromEntries(WARNING.map((s) => [s, 'warning' as const])),
    ...Object.fromEntries(SUCCESS.map((s) => [s, 'success' as const])),
    ...Object.fromEntries(MUTED.map((s) => [s, 'muted' as const])),
});

/** The tone of a lifecycle state; neutral for anything this map does not know. */
export function toneOfRegisterState(state: string | null | undefined): RegisterStateTone {
    const key = String(state ?? '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(REGISTER_STATE_TONES, key) ? REGISTER_STATE_TONES[key] : 'neutral';
}

/**
 * The pill's classes per tone: a solid 1px hairline (never dashed), text in
 * the tone's INK. Literals, because Tailwind emits only what it can read.
 */
export const REGISTER_STATE_CLASS: Readonly<Record<RegisterStateTone, string>> = Object.freeze({
    neutral: 'border-[var(--text-tertiary)] text-[var(--text-primary)]',
    warning: 'border-[var(--warning)] text-[var(--warning-ink)]',
    success: 'border-[var(--success)] text-[var(--success-ink)]',
    muted: 'border-[var(--border-default)] text-[var(--text-tertiary)]',
});
