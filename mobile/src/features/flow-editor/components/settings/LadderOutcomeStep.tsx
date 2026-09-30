/**
 * The last page: what the three steps add up to, before anything is
 * recorded — the web's OutcomeBox, with what Art. 50 still misses, when the
 * routine was last declared, and why a save did not go through.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Text } from '@/shared/ui';

import { isPending } from './ladderModel';
import { outcomeText, savedStamp, step2OpenLine } from './ladderWords';
import type { AiActLadder } from './useAiActLadder';

export function LadderOutcomeStep({ ladder }: { ladder: AiActLadder }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { verdict, containsAi } = ladder;
    const open = step2OpenLine(verdict, t);
    const stamp = savedStamp(ladder.assessment, t);
    const code = isPending(verdict, containsAi) ? 'pending' : verdict.outcomeCode;
    return (
        <>
            <View style={styles.box} testID={`ladder-outcome-${code}`} accessibilityLiveRegion="polite">
                <Text variant="body" weight="semibold">
                    {outcomeText(verdict, containsAi, t)}
                </Text>
                {open ? (
                    <Text variant="caption" tone="error">
                        {open}
                    </Text>
                ) : null}
                <Text variant="caption" tone="secondary">
                    {t('compliance.ladder_outcome_note', 'Recorded in the model inventory (Art. 53) and as a processing activity in the processing register; the "AI notice" and "marking" checks keep running automatically.')}
                </Text>
            </View>
            {stamp ? (
                <Text variant="caption" tone="tertiary" testID="ladder-saved-stamp">
                    {stamp}
                </Text>
            ) : null}
            {ladder.saveError ? <Banner tone="error">{ladder.saveError}</Banner> : null}
        </>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        box: {
            gap: theme.spacing.xs,
            padding: theme.spacing.md,
            borderRadius: theme.radii.sm,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.borderDefault,
            backgroundColor: theme.colors.bgPrimary,
        },
    });
