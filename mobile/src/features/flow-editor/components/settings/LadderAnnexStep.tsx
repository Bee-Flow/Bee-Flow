/**
 * Step 3 — Annex III: ten questions, one per high-risk domain, the ones the
 * automation's own wording mentions first. "No" needs all ten; any "yes" makes
 * it high-risk and says under which point of the annex. A row declared 'yes'
 * before the ten questions existed asks to pick the area(s) to confirm.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Text } from '@/shared/ui';

import { LadderAnnexQuestion } from './LadderAnnexQuestion';
import { orderByHints } from './ladderModel';
import { annexAnsweredCount, annexArticlesFor } from './ladderOutcome';
import { LadderStepHeader } from './LadderStepHeader';
import { ANNEX_QUESTIONS, step3Verdict, stepWords } from './ladderWords';
import type { AiActLadder } from './useAiActLadder';

export function LadderAnnexStep({ ladder }: { ladder: AiActLadder }) {
    const t = useTranslation();
    const words = stepWords(3, t);
    const hints = ladder.signals?.annexHints ?? [];
    const articles = annexArticlesFor(ladder.domains);
    const { step3 } = ladder.verdict;
    return (
        <>
            <LadderStepHeader
                n={3}
                state={step3.ok ? 'done' : 'open'}
                title={words.title}
                meta={words.meta}
                verdict={step3Verdict(ladder.verdict, annexAnsweredCount(ladder.domains), t)}
            />
            {ladder.legacyYes ? (
                <Text variant="caption" weight="medium" tone="warning" testID="ladder-legacy-yes-note">
                    {t('compliance.ladder_legacy_yes_note', 'Declared high-risk earlier — pick the area(s) to confirm')}
                </Text>
            ) : null}
            <View>
                {orderByHints(ANNEX_QUESTIONS, hints).map((q) => (
                    <LadderAnnexQuestion key={q.id} question={q} value={ladder.domains[q.id]} hinted={hints.includes(q.id)} onAnswer={ladder.answer} />
                ))}
            </View>
            {articles.length > 0 ? (
                <Text variant="caption" weight="medium" tone="error" testID="ladder-annex-articles">
                    {t('compliance.ladder_annex_high_risk_points', 'High risk under {points}.', { points: articles.join(', ') })}
                </Text>
            ) : null}
            <Text variant="caption" tone="tertiary">
                {t('compliance.ladder_step3_note', 'If this does become high-risk later: risk management, technical documentation and human oversight are 12–18 months of work, not a quarter.')}
            </Text>
        </>
    );
}
