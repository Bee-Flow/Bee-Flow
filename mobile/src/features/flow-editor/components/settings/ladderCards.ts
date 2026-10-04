/**
 * The two Art. 50 sub-cards of the ladder's second step — the web's
 * DisclosureCard and MarkingCard (AiActLadderModal.jsx): what the checks see,
 * never answered by hand. An unknown signal is neutral, never a failure.
 * Pure; the words are pinned by ladderModel.lockstep.test.ts.
 */

import type { TranslateFn } from '@/core/i18n';
import type { AiActSignals } from '@/features/flow-editor/api';
import type { IconName } from '@/shared/ui';

import { markingDeadlineLine } from './ladderWords';

export type CardTone = 'success' | 'error' | 'neutral';

export interface SubCardWords {
    icon: IconName;
    tone: CardTone;
    title: string;
    detail: string;
}

/** Art. 50(1): an automation that talks to people says it is AI. */
export function disclosureCard(signals: AiActSignals | null, t: TranslateFn): SubCardWords {
    const icon: IconName = 'MessageSquare';
    if (signals?.customerFacing !== true) {
        return {
            icon,
            tone: 'neutral',
            title: t('compliance.ladder_talks_no', 'Talks to people: no'),
            detail: t('compliance.ladder_talks_no_detail', 'No form page, form trigger or published surface — no AI notice needed.'),
        };
    }
    if (signals.disclosurePresent === true) {
        return {
            icon,
            tone: 'success',
            title: t('compliance.ladder_talks_yes_ok', 'Talks to people: yes → AI notice shown'),
            detail: t('compliance.ladder_talks_yes_ok_detail', 'The public page says it was made with AI · checked automatically'),
        };
    }
    if (signals.disclosurePresent === false) {
        return {
            icon,
            tone: 'error',
            title: t('compliance.ladder_talks_yes_missing', 'Talks to people: yes → AI notice missing'),
            detail: t('compliance.ladder_talks_yes_missing_detail', 'Add a line such as "calculated with AI" to the ending page or the greeting; the check picks it up automatically.'),
        };
    }
    return {
        icon,
        tone: 'neutral',
        title: t('compliance.ladder_talks_yes_unknown', 'Talks to people: yes → AI notice'),
        detail: t('compliance.ladder_talks_yes_unknown_detail', 'Whether the notice is shown is checked automatically once the assessment is recorded.'),
    };
}

/** Art. 50(2): generated documents carry the AI marking. */
export function markingCard(signals: AiActSignals | null, t: TranslateFn, now: Date | number = new Date()): SubCardWords {
    const icon: IconName = 'FileText';
    if (signals?.generatesContent !== true) {
        return {
            icon,
            tone: 'neutral',
            title: t('compliance.ladder_generates_no', 'Generates content: no'),
            detail: t('compliance.ladder_generates_no_detail', 'No document step writes model output to a file — no marking needed.'),
        };
    }
    if (signals.markingEnabled === true) {
        return {
            icon,
            tone: 'success',
            title: t('compliance.ladder_generates_yes_ok', 'Generates content: yes → marking on'),
            detail: t('compliance.ladder_generates_yes_ok_detail', 'Generated documents carry the AI marking footer · checked automatically'),
        };
    }
    const missing = signals.markingEnabled === false;
    return {
        icon,
        tone: missing ? 'error' : 'neutral',
        title: missing
            ? t('compliance.ladder_generates_yes_missing', 'Generates content: yes → marking missing')
            : t('compliance.ladder_generates_yes_unknown', 'Generates content: yes → marking'),
        detail: `${t('compliance.ladder_marking_detail', 'AI text in a generated document without a marking')} · ${markingDeadlineLine(t, now)}`,
    };
}
