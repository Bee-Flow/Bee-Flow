/**
 * The ladder sheet's state: which step is showing, the Art. 5 ticks, the ten
 * Annex III answers, the live verdict, and the declaration's save. Starts
 * from the saved declaration (the sheet is mounted only while open, so each
 * opening starts afresh). The server recomputes the outcome from its own
 * signals and stamps who and when; the verdict here is what the person sees
 * before recording it.
 */

import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import type { AiActAssessment, AiActYesNo } from '@/features/flow-editor/api';
import { useSaveAiActAssessment } from '@/features/flow-editor/hooks';
import { useToast } from '@/shared/ui';

import {
    annexFromDomains,
    answerDomain,
    art5FromDenied,
    canRecord,
    LADDER_PAGES,
    prefill,
    toggleDenied,
    type LadderPage,
} from './ladderModel';
import { inputFromSignals, outcome, toAnswers, type DomainAnswers } from './ladderOutcome';

export type AiActLadder = ReturnType<typeof useAiActLadder>;

export function useAiActLadder(automationId: string, assessment: AiActAssessment | null, onRecorded: () => void) {
    const t = useTranslation();
    const { toast } = useToast();
    const [start] = useState(() => prefill(assessment?.answers));
    const [denied, setDenied] = useState<string[]>(start.denied);
    const [domains, setDomains] = useState<DomainAnswers>(start.domains);
    const [index, setIndex] = useState(0);
    const save = useSaveAiActAssessment(automationId, {
        onSuccess: () => {
            toast(t('compliance.ladder_toast_recorded', 'Recorded as self-declared — stamped with who and when, valid for 12 months.'), 'success');
            onRecorded();
        },
    });

    const signals = assessment?.signals ?? null;
    const art5 = art5FromDenied(denied);
    const annexIii = annexFromDomains(domains);
    const verdict = outcome(inputFromSignals(signals, { art5, annexIii }));
    const containsAi = signals?.containsAi === true;
    const page: LadderPage = LADDER_PAGES[index] ?? 'art5';

    return {
        page,
        step: index + 1,
        next: () => setIndex((i) => Math.min(i + 1, LADDER_PAGES.length - 1)),
        back: () => setIndex((i) => Math.max(i - 1, 0)),
        denied,
        toggle: (id: string) => setDenied((d) => toggleDenied(d, id)),
        domains,
        answer: (id: string, value: AiActYesNo) => setDomains((d) => answerDomain(d, id, value)),
        assessment,
        signals,
        verdict,
        containsAi,
        canRecord: canRecord(verdict, containsAi),
        record: () => save.mutate(toAnswers({ art5, annexIii, signals })),
        saving: save.isPending,
        saveError: save.error
            ? t('compliance.ladder_action_failed', 'That did not save — {error}', { error: describeError(save.error).message })
            : null,
    };
}
