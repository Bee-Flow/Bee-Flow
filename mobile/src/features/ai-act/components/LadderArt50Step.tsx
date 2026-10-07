/**
 * Step 2 — Art. 50: nothing to answer. What the checks see: whether the
 * automation talks to people and says it is AI, and whether it generates
 * content and marks it — with a one-tap "Enable marking" when it does not.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Button, Text } from '@/shared/ui';

import { LadderStepHeader } from './LadderStepHeader';
import { LadderSubCard } from './LadderSubCard';
import type { AiActLadder } from './useAiActLadder';
import { disclosureCard, markingCard } from '../model/ladderCards';
import { step2State } from '../model/ladderModel';
import { step2Verdict, stepWords } from '../model/ladderWords';

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
            <LadderSubCard card={markingCard(ladder.signals, t)} testID="ladder-card-marking">
                {ladder.signals?.generatesContent === true && ladder.signals.markingEnabled === false ? (
                    <Button
                        label={t('compliance.ladder_enable_marking', 'Enable marking')}
                        iconName="Wrench"
                        variant="secondary"
                        size="sm"
                        onPress={ladder.enableMarking}
                        loading={ladder.enablingMarking}
                        testID="ladder-enable-marking"
                    />
                ) : null}
                {ladder.markingError ? (
                    <Text variant="caption" tone="error">
                        {ladder.markingError}
                    </Text>
                ) : null}
            </LadderSubCard>
        </>
    );
}
