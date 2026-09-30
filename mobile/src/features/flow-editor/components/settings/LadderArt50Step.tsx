/**
 * Step 2 — Art. 50: nothing to answer. What the checks see: whether the
 * routine talks to people and says it is AI, and whether it generates
 * content and marks it.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';

import { disclosureCard, markingCard } from './ladderCards';
import { step2State } from './ladderModel';
import { LadderStepHeader } from './LadderStepHeader';
import { LadderSubCard } from './LadderSubCard';
import { step2Verdict, stepWords } from './ladderWords';
import type { AiActLadder } from './useAiActLadder';

export function LadderArt50Step({ ladder }: { ladder: AiActLadder }) {
    const t = useTranslation();
    const words = stepWords(2, t);
    return (
        <>
            <LadderStepHeader
                n={2}
                state={step2State(ladder.verdict.step2)}
                title={words.title}
                meta={words.meta}
                verdict={step2Verdict(ladder.verdict, t)}
            />
            <LadderSubCard card={disclosureCard(ladder.signals, t)} testID="ladder-card-disclosure" />
            <LadderSubCard card={markingCard(ladder.signals, t)} testID="ladder-card-marking" />
        </>
    );
}
