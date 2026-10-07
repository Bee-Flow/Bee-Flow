/**
 * "Does the AI Act apply to this agent / automation?" — the web's AiActLadderModal,
 * natively, one step at a time: Art. 5 (prohibited practices) → Art. 50
 * (transparency, what the checks see) → Annex III (high-risk), then the
 * outcome before anything is recorded. Recording PUTs the answers; the
 * server recomputes the outcome from its own signals and stamps who and when.
 *
 * Mounted only while open, so each opening starts from the saved declaration.
 */

import React, { type ComponentType } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Banner, LoadingState, Sheet } from '@/shared/ui';

import type { AiActAssessment, AiActKind, AiActSignals } from '../api';
import { useAiActAssessment } from '../hooks';
import { LadderAnnexStep } from './LadderAnnexStep';
import { LadderArt50Step } from './LadderArt50Step';
import { LadderArt5Step } from './LadderArt5Step';
import { LadderFooter } from './LadderFooter';
import { LadderOutcomeStep } from './LadderOutcomeStep';
import { useAiActLadder, type AiActLadder } from './useAiActLadder';
import type { LadderPage } from '../model/ladderModel';

const PAGES: Record<LadderPage, ComponentType<{ ladder: AiActLadder }>> = {
    art5: LadderArt5Step,
    art50: LadderArt50Step,
    annex: LadderAnnexStep,
    outcome: LadderOutcomeStep,
};

type Props = { kind: AiActKind; id: string; onClose: () => void };

/** The web's subtitle: '{n} steps', the AI steps, and 'customer-facing via {surface}'. */
function subtitleOf(signals: AiActSignals | null, t: TranslateFn): string | undefined {
    if (!signals) return undefined;
    const parts: string[] = [];
    const steps = signals.stepCount;
    if (typeof steps === 'number') {
        parts.push(steps === 1 ? t('compliance.ladder_sub_steps_one', '1 step') : t('compliance.ladder_sub_steps', '{n} steps', { n: steps }));
    }
    const ai = signals.aiSteps ?? 0;
    parts.push(ai === 1 ? t('compliance.ladder_sub_ai_steps_one', '1 AI step') : t('compliance.ladder_sub_ai_steps', '{n} AI steps', { n: ai }));
    const surface = surfaceWords(signals.surface, t);
    if (surface) parts.push(t('compliance.ladder_sub_surface', 'customer-facing via {surface}', { surface }));
    return parts.join(' · ');
}

function surfaceWords(surface: string | null | undefined, t: TranslateFn): string | null {
    if (!surface) return null;
    if (surface === 'form') return t('compliance.ladder_surface_form', 'a form');
    if (surface === 'published_agent') return t('compliance.ladder_surface_agent', 'a published agent');
    if (surface === 'webpage') return t('compliance.ladder_surface_webpage', 'a web page');
    return surface;
}

const titleOf = (kind: AiActKind, t: TranslateFn) =>
    kind === 'agent'
        ? t('compliance.ladder_title_agent', 'Does the AI Act apply to this agent?')
        : t('compliance.ladder_title_automation', 'Does the AI Act apply to this automation?');

function LoadedLadder({ kind, id, assessment, failed, onClose }: Props & { assessment: AiActAssessment | null; failed: boolean }) {
    const t = useTranslation();
    const ladder = useAiActLadder(kind, id, assessment, onClose);
    const Page = PAGES[ladder.page];
    return (
        <Sheet
            visible
            onClose={onClose}
            title={titleOf(kind, t)}
            subtitle={subtitleOf(ladder.signals, t)}
            footer={<LadderFooter ladder={ladder} onClose={onClose} />}
            tall
        >
            {failed ? (
                <Banner tone="error">
                    {t('compliance.ladder_load_failed', 'The saved assessment could not be read — the signals below come from the definition itself.')}
                </Banner>
            ) : null}
            <Page ladder={ladder} />
        </Sheet>
    );
}

/**
 * Opened with the saved assessment (the Compliance block), it starts at once;
 * opened without one (the Systems list), it reads it first.
 */
export function AiActLadderSheet({ kind, id, assessment, onClose }: Props & { assessment?: AiActAssessment | null }) {
    const t = useTranslation();
    const prefetched = assessment !== undefined;
    const query = useAiActAssessment(kind, id, !prefetched);
    if (!prefetched && query.isPending) {
        return (
            <Sheet visible onClose={onClose} title={titleOf(kind, t)} tall>
                <LoadingState />
            </Sheet>
        );
    }
    const row = prefetched ? assessment : (query.data ?? null);
    return <LoadedLadder kind={kind} id={id} assessment={row} failed={!prefetched && query.isError} onClose={onClose} />;
}
