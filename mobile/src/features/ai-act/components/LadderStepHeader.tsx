/**
 * One ladder step's head — the web's Step (AiActLadderModal.jsx): the
 * numbered disc (green once done, red while failing, grey while open), the
 * step's title and date line, and its verdict on the right.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text, tint, tonePair, type TextTone } from '@/shared/ui';

import type { StepState } from '../model/ladderModel';

const VERDICT_TONE: Record<StepState, TextTone> = { done: 'success', failing: 'error', open: 'secondary' };

export function LadderStepHeader({ n, state, title, meta, verdict }: { n: number; state: StepState; title: string; meta: string; verdict: string | null }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row} testID={`ladder-step-${n}`}>
            <View style={[styles.disc, styles[state]]} testID={`ladder-step-${n}-disc`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Text variant="caption" weight="semibold" style={styles[`${state}Ink`]}>
                    {String(n)}
                </Text>
            </View>
            <View style={styles.titles}>
                <Text variant="subheading" accessibilityRole="header">
                    {title}
                </Text>
                <Text variant="caption" tone="tertiary">
                    {meta}
                </Text>
            </View>
            {verdict ? (
                <Text variant="caption" weight="semibold" tone={VERDICT_TONE[state]} testID={`ladder-step-${n}-verdict`}>
                    {verdict}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => {
    const success = tonePair(theme.colors, 'success');
    const error = tonePair(theme.colors, 'error');
    return StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md },
        disc: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
        done: { backgroundColor: tint(success.raw, 14), borderColor: success.raw },
        failing: { backgroundColor: tint(error.raw, 14), borderColor: error.raw },
        open: { backgroundColor: theme.colors.bgTertiary, borderColor: theme.colors.borderDefault },
        doneInk: { color: success.ink },
        failingInk: { color: error.ink },
        openInk: { color: theme.colors.textTertiary },
        titles: { flex: 1, gap: 2 },
    });
};
