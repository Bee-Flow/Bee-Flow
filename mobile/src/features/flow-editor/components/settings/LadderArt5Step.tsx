/**
 * Step 1 — Art. 5: the eight prohibited practices, each denied with a tick.
 * Only all eight make the answer "no"; one left open leaves the step open.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { CheckRow } from '@/shared/ui';

import { LadderContainsAi } from './LadderContainsAi';
import { LadderStepHeader } from './LadderStepHeader';
import { ART5_CHIPS, step1Verdict, stepWords } from './ladderWords';
import type { AiActLadder } from './useAiActLadder';

export function LadderArt5Step({ ladder }: { ladder: AiActLadder }) {
    const t = useTranslation();
    const words = stepWords(1, t);
    return (
        <>
            <LadderContainsAi signals={ladder.signals} />
            <LadderStepHeader
                n={1}
                state={ladder.verdict.step1.ok ? 'done' : 'open'}
                title={words.title}
                meta={words.meta}
                verdict={step1Verdict(ladder.verdict, t)}
            />
            <View accessibilityRole="list">
                {ART5_CHIPS.map((chip) => (
                    <CheckRow
                        key={chip.id}
                        checked={ladder.denied.includes(chip.id)}
                        onToggle={() => ladder.toggle(chip.id)}
                        label={t(chip.key, chip.en)}
                    />
                ))}
            </View>
        </>
    );
}
