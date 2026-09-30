/**
 * "Does the AI Act apply to this automation?" — the web's AiActLadderModal,
 * natively, one step at a time: Art. 5 (prohibited practices) → Art. 50
 * (transparency, what the checks see) → Annex III (high-risk), then the
 * outcome before anything is recorded. Recording PUTs the answers; the
 * server recomputes the outcome from its own signals and stamps who and when.
 *
 * Mounted only while open, so each opening starts from the saved declaration.
 */

import React, { type ComponentType } from 'react';

import { useTranslation } from '@/core/i18n';
import type { AiActAssessment } from '@/features/flow-editor/api';
import { Sheet } from '@/shared/ui';

import { LadderAnnexStep } from './LadderAnnexStep';
import { LadderArt50Step } from './LadderArt50Step';
import { LadderArt5Step } from './LadderArt5Step';
import { LadderFooter } from './LadderFooter';
import type { LadderPage } from './ladderModel';
import { LadderOutcomeStep } from './LadderOutcomeStep';
import { useAiActLadder, type AiActLadder } from './useAiActLadder';

const PAGES: Record<LadderPage, ComponentType<{ ladder: AiActLadder }>> = {
    art5: LadderArt5Step,
    art50: LadderArt50Step,
    annex: LadderAnnexStep,
    outcome: LadderOutcomeStep,
};

export function AiActLadderSheet({ automationId, assessment, onClose }: { automationId: string; assessment: AiActAssessment | null; onClose: () => void }) {
    const t = useTranslation();
    const ladder = useAiActLadder(automationId, assessment, onClose);
    const aiSteps = ladder.signals?.aiSteps;
    const Page = PAGES[ladder.page];
    return (
        <Sheet
            visible
            onClose={onClose}
            title={t('compliance.ladder_title_automation', 'Does the AI Act apply to this automation?')}
            subtitle={aiSteps !== null && aiSteps !== undefined ? t('compliance.ladder_sub_ai_steps', '{n} AI steps', { n: aiSteps }) : undefined}
            footer={<LadderFooter ladder={ladder} onClose={onClose} />}
            tall
        >
            <Page ladder={ladder} />
        </Sheet>
    );
}
