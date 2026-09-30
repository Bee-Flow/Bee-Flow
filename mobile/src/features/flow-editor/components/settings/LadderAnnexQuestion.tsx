/**
 * One Annex III question — the web's AnnexQuestions row: the question, the
 * point of the annex it cites (and whether the routine's own wording
 * mentions it), and a No/Yes pair that starts on neither. Pressing the
 * answer already given takes it back to open.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { AiActYesNo } from '@/features/flow-editor/api';
import { Chip, Text } from '@/shared/ui';

import { ANNEX_III_ARTICLES, type AnnexDomain } from './ladderOutcome';
import type { Worded } from './ladderWords';

export function LadderAnnexQuestion({
    question,
    value,
    hinted,
    onAnswer,
}: {
    question: Worded<AnnexDomain>;
    value: AiActYesNo | undefined;
    hinted: boolean;
    onAnswer: (id: string, value: AiActYesNo) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const text = t(question.key, question.en);
    return (
        <View style={styles.row} testID={`ladder-annex-${question.id}`}>
            <View style={styles.words}>
                <Text variant="caption">{text}</Text>
                <Text variant="label" tone="tertiary">
                    {ANNEX_III_ARTICLES[question.id]}
                    {hinted ? ` · ${t('compliance.ladder_annex_mentioned', 'this routine’s wording mentions it')}` : ''}
                </Text>
            </View>
            <View style={styles.pair} accessibilityRole="radiogroup" accessibilityLabel={text}>
                <Chip
                    label={t('compliance.ladder_no', 'No')}
                    tone="success"
                    selected={value === 'no'}
                    onPress={() => onAnswer(question.id, 'no')}
                    testID={`ladder-annex-${question.id}-no`}
                />
                <Chip
                    label={t('compliance.ladder_yes', 'Yes')}
                    tone="error"
                    selected={value === 'yes'}
                    onPress={() => onAnswer(question.id, 'yes')}
                    testID={`ladder-annex-${question.id}-yes`}
                />
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing[1.5] },
        words: { flex: 1, gap: 2 },
        pair: { flexDirection: 'row', gap: theme.spacing.xs },
    });
