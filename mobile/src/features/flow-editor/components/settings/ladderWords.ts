/**
 * The ladder's words — the web's AiActLadderModal.jsx, under its own keys
 * and in its own English: the eight Art. 5 ticks, the ten Annex III
 * questions, each step's title, date line and verdict, the two Art. 50
 * sub-cards, and the outcome. Pure; ladderModel.lockstep.test.ts checks every
 * key and sentence here against the web file.
 */

import type { TranslateFn } from '@/core/i18n';
import type { AiActAssessment, AiActSignals } from '@/features/flow-editor/api';

import { isPending } from './ladderModel';
import {
    ANNEX_III_CATEGORIES,
    ANNEX_III_FROM,
    ART5_IN_FORCE,
    ART50_IN_FORCE,
    daysUntilMarkingDeadline,
    MARKING_DEADLINE,
    type AnnexDomain,
    type Verdict,
} from './ladderOutcome';

export interface Worded<Id extends string = string> {
    id: Id;
    key: string;
    en: string;
}

/** Art. 5 — all eight prohibited practices, each a "no …" tick. */
export const ART5_CHIPS: readonly Worded[] = [
    { id: 'subliminal_manipulation', key: 'compliance.ladder_art5_chip_subliminal', en: 'no subliminal manipulation' },
    { id: 'exploiting_vulnerabilities', key: 'compliance.ladder_art5_chip_vulnerabilities', en: 'no exploiting vulnerabilities' },
    { id: 'social_scoring', key: 'compliance.ladder_art5_chip_social', en: 'no social scoring' },
    { id: 'criminal_risk_profiling', key: 'compliance.ladder_art5_chip_criminal', en: 'no criminal risk profiling' },
    { id: 'facial_scraping', key: 'compliance.ladder_art5_chip_scraping', en: 'no untargeted facial scraping' },
    { id: 'emotion_recognition_work_education', key: 'compliance.ladder_art5_chip_emotion', en: 'no emotion recognition at work or school' },
    { id: 'biometric_categorisation', key: 'compliance.ladder_art5_chip_biometric', en: 'no biometric categorisation' },
    { id: 'realtime_biometric_id', key: 'compliance.ladder_art5_chip_realtime_id', en: 'no real-time biometric identification' },
];

/** Annex III — one question per domain, all ten. */
export const ANNEX_QUESTIONS: readonly Worded<AnnexDomain>[] = [
    { id: 'biometrics', key: 'compliance.ladder_annex_q_biometrics', en: 'Does it identify or categorise people by biometrics?' },
    { id: 'critical_infrastructure', key: 'compliance.ladder_annex_q_critical_infrastructure', en: 'Does it help run critical infrastructure (water, power, traffic)?' },
    { id: 'education', key: 'compliance.ladder_annex_q_education', en: 'Does it decide on admission, assessment or monitoring in education?' },
    { id: 'employment', key: 'compliance.ladder_annex_q_employment', en: 'Does it select, assess or decide about people at work?' },
    { id: 'essential_services', key: 'compliance.ladder_annex_q_essential_services', en: 'Does it decide on access to essential public services or benefits?' },
    { id: 'credit', key: 'compliance.ladder_annex_q_credit', en: 'Does it judge creditworthiness or score credit?' },
    { id: 'insurance', key: 'compliance.ladder_annex_q_insurance', en: 'Does it price or assess risk for life or health insurance?' },
    { id: 'law_enforcement', key: 'compliance.ladder_annex_q_law_enforcement', en: 'Is it used by or for law enforcement?' },
    { id: 'migration', key: 'compliance.ladder_annex_q_migration', en: 'Is it used for migration, asylum or border control?' },
    { id: 'justice', key: 'compliance.ladder_annex_q_justice', en: 'Does it support judicial decisions or democratic processes?' },
];

/** '2 Feb 2025' — a calendar day (YYYY-MM-DD read as local) or a timestamp; '' for none. */
export function calDate(value: string | null | undefined): string {
    if (!value) return '';
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export interface StepWords {
    title: string;
    meta: string;
}

/** Each step's title and the date line under it. */
export function stepWords(step: 1 | 2 | 3, t: TranslateFn): StepWords {
    if (step === 1) {
        return {
            title: t('compliance.ladder_step1_title', 'Art. 5 — prohibited practice?'),
            meta: t('compliance.ladder_step1_meta', 'in force since {date} · no delay', { date: calDate(ART5_IN_FORCE) }),
        };
    }
    if (step === 2) {
        return {
            title: t('compliance.ladder_step2_title', 'Art. 50 — transparency'),
            meta: t('compliance.ladder_step2_meta', 'in force since {date} — this is what is missed most', { date: calDate(ART50_IN_FORCE) }),
        };
    }
    return {
        title: t('compliance.ladder_step3_title', 'Annex III — high-risk?'),
        meta: t('compliance.ladder_step3_meta', 'from {date} — but what you build now falls under it then', { date: calDate(ANNEX_III_FROM) }),
    };
}

/** Step 1's verdict: "No" once all eight are ticked. */
export function step1Verdict(verdict: Verdict, t: TranslateFn): string | null {
    return verdict.step1.ok ? t('compliance.ladder_no', 'No') : null;
}

/** Step 2's score — only when every applicable check is KNOWN; never "0 of 2". */
export function step2Verdict(verdict: Verdict, t: TranslateFn): string | null {
    const { checks, passed, failures } = verdict.step2;
    if (checks === 0 || passed + failures.length !== checks) return null;
    return t('compliance.ladder_step2_score', '{passed} of {checks} in order', { passed, checks });
}

/** Step 3's verdict, or how far along it is: "4 of 10" is not "no". */
export function step3Verdict(verdict: Verdict, answeredCount: number, t: TranslateFn): string {
    if (verdict.step3.answered) return verdict.step3.ok ? t('compliance.ladder_no', 'No') : t('compliance.ladder_yes', 'Yes');
    return t('compliance.ladder_annex_progress', '{answered} of {total} answered', { answered: answeredCount, total: ANNEX_III_CATEGORIES.length });
}

/** "Contains AI:" and what the checks found. */
export function containsAiWords(signals: AiActSignals | null, t: TranslateFn): { lead: string; body: string; note: string | null } {
    const lead = t('compliance.ladder_contains_ai', 'Contains AI:');
    if (!signals) return { lead, body: t('compliance.ladder_signals_loading', 'reading the definition…'), note: null };
    if (signals.containsAi !== true) {
        return {
            lead,
            body: t('compliance.ladder_contains_ai_no', 'no — none of the steps calls a model.'),
            note: t('compliance.ladder_no_ai_note', 'Without AI only the GDPR applies: Art. 22 for decisions with legal effect, WOR Art. 27 for employee monitoring.'),
        };
    }
    const names = signals.aiStepLabels;
    if (names.length === 1) return { lead, body: t('compliance.ladder_contains_ai_yes_one', 'yes — step "{name}" is an AI step.', { name: names[0] as string }), note: null };
    if (names.length > 1) {
        return { lead, body: t('compliance.ladder_contains_ai_yes_many', 'yes — {names} are AI steps.', { names: names.map((n) => `"${n}"`).join(', ') }), note: null };
    }
    return { lead, body: t('compliance.ladder_contains_ai_yes', 'yes — this is an AI system.'), note: null };
}

/** The outcome sentence (the web's exported outcomeText). */
export function outcomeText(verdict: Verdict, containsAi: boolean, t: TranslateFn): string {
    if (isPending(verdict, containsAi)) {
        return t('compliance.ladder_outcome_pending', 'Outcome: pending — tick the chips of steps 1 and 3 to declare.');
    }
    switch (verdict.outcomeCode) {
        case 'not_applicable':
            return t('compliance.ladder_outcome_not_applicable', 'Outcome: the AI Act does not apply — no step calls a model. Only the GDPR applies.');
        case 'prohibited':
            return t('compliance.ladder_outcome_prohibited', 'Outcome: prohibited practice (Art. 5) — this may not run.');
        case 'high_risk':
            return t('compliance.ladder_outcome_high_risk', 'Outcome: the AI Act applies — high-risk (Annex III). Risk management, technical documentation and human oversight are required.');
        case 'transparency':
            return t('compliance.ladder_outcome_transparency', 'Outcome: the AI Act applies — Art. 4 (literacy) and Art. 50 (transparency). Not high-risk.');
        default:
            return t('compliance.ladder_outcome_minimal', 'Outcome: the AI Act applies — Art. 4 (literacy). Minimal risk: no customer contact, no generated content.');
    }
}

/** What Art. 50 still misses, or null. */
export function step2OpenLine(verdict: Verdict, t: TranslateFn): string | null {
    const { failures } = verdict.step2;
    if (!failures.length) return null;
    const items = failures
        .map((f) => (f === 'disclosure' ? t('compliance.ladder_fail_disclosure', 'AI notice') : t('compliance.ladder_fail_marking', 'content marking')))
        .join(', ');
    return t('compliance.ladder_outcome_step2_open', 'Art. 50 still open: {items}.', { items });
}

/** "Last declared …, valid until …", or null before the first declaration. */
export function savedStamp(assessment: AiActAssessment | null, t: TranslateFn): string | null {
    if (!assessment?.attestedAt) return null;
    return t('compliance.ladder_saved_stamp', 'Last declared {date}, valid until {expires}.', {
        date: calDate(assessment.attestedAt),
        expires: assessment.expiresAt ? calDate(assessment.expiresAt) : '—',
    });
}

/** The Art. 50(2) date line under a marking card. */
export function markingDeadlineLine(t: TranslateFn, now: Date | number = new Date()): string {
    const days = daysUntilMarkingDeadline(now);
    const date = calDate(MARKING_DEADLINE);
    return days >= 0
        ? t('compliance.ladder_marking_deadline', 'mandatory for existing systems from {date} (in {days} days)', { date, days })
        : t('compliance.ladder_marking_deadline_passed', 'mandatory for existing systems since {date}', { date });
}
