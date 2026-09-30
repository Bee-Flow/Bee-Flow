/**
 * The Compliance block's words — the web's ComplianceBlock.jsx (agent-hub
 * components/admin/compliance/ladder): the saved outcome as a chip (declared,
 * expired, or not assessed) and the one line of signals the checks see.
 * Pure; pinned by complianceModel.lockstep.test.ts.
 */

import type { TranslateFn } from '@/core/i18n';
import type { AiActAssessment, AiActOutcome } from '@/features/flow-editor/api';

export const OUTCOME_LABEL: Readonly<Record<AiActOutcome, { key: string; en: string }>> = {
    not_applicable: { key: 'compliance.ladder_outcome_chip_not_applicable', en: 'AI Act not applicable' },
    prohibited: { key: 'compliance.ladder_outcome_chip_prohibited', en: 'Prohibited (Art. 5)' },
    high_risk: { key: 'compliance.ladder_outcome_chip_high_risk', en: 'High-risk (Annex III)' },
    transparency: { key: 'compliance.ladder_outcome_chip_transparency', en: 'Art. 4 + Art. 50' },
    minimal: { key: 'compliance.ladder_outcome_chip_minimal', en: 'Minimal risk' },
};

export type ChipTone = 'neutral' | 'warning' | 'error' | 'success';

/** The web's chipState: none until attested, expired once lapsed, red for a prohibited practice. */
export function chipState(assessment: AiActAssessment | null, now: number = Date.now()): { tone: ChipTone; state: 'declared' | 'expired' | 'none' } {
    if (!assessment?.outcome || !assessment.attestedAt) return { tone: 'neutral', state: 'none' };
    const exp = assessment.expiresAt ? new Date(assessment.expiresAt).getTime() : NaN;
    if (assessment.current === false || (Number.isFinite(exp) && exp < now)) return { tone: 'warning', state: 'expired' };
    if (assessment.outcome === 'prohibited') return { tone: 'error', state: 'declared' };
    return { tone: 'success', state: 'declared' };
}

/** The chip's words. */
export function chipLabel(assessment: AiActAssessment | null, t: TranslateFn, now: number = Date.now()): string {
    const chip = chipState(assessment, now);
    if (chip.state === 'none') return t('compliance.ladder_chip_not_assessed', 'Not assessed');
    if (chip.state === 'expired') return t('compliance.ladder_chip_expired', 'Expired');
    const date = new Date(assessment?.attestedAt as string).toLocaleDateString();
    return t('compliance.ladder_chip_declared', 'Self-declared {date}', { date });
}

/** The outcome in words, for a screen reader beside the chip. */
export function outcomeWords(assessment: AiActAssessment | null, t: TranslateFn): string | null {
    const label = assessment?.outcome ? OUTCOME_LABEL[assessment.outcome] : null;
    return label ? t(label.key, label.en) : null;
}

/** The web's signalsLine for a routine: AI steps, who it faces, whether it generates content. */
export function signalsLine(assessment: AiActAssessment | null, t: TranslateFn): string | null {
    const s = assessment?.signals;
    if (!s) return null;
    const parts: string[] = [];
    if (s.containsAi === true) {
        parts.push(s.aiSteps !== null ? t('compliance.ladder_sig_ai_steps', '{n} AI steps', { n: s.aiSteps }) : t('compliance.ladder_sig_contains_ai', 'contains AI'));
    } else if (s.containsAi === false) {
        parts.push(t('compliance.ladder_sig_no_ai', 'no AI steps'));
    }
    if (s.customerFacing === true) parts.push(t('compliance.ladder_sig_customer_facing', 'customer-facing'));
    else if (s.customerFacing === false) parts.push(t('compliance.ladder_sig_internal', 'internal only'));
    if (s.generatesContent === true) parts.push(t('compliance.ladder_sig_generates', 'generates content'));
    return parts.length ? parts.join(' · ') : null;
}
