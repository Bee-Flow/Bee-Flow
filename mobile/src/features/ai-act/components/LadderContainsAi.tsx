/**
 * Above the first question: whether the automation contains AI at all, and
 * which steps make it so — the web's ContainsAiBanner. Without AI the AI Act
 * does not apply and the note says what does.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import type { AiActSignals } from '../api';
import { containsAiWords } from '../model/ladderWords';

export function LadderContainsAi({ signals }: { signals: AiActSignals | null }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const words = containsAiWords(signals, t);
    const known = signals ? String(signals.containsAi === true) : 'unknown';
    return (
        <View style={styles.banner} testID={`ladder-contains-ai-${known}`}>
            <Icon name="Sparkles" size={16} color={theme.colors.typeAi} />
            <View style={styles.body}>
                <Text variant="caption">
                    <Text variant="caption" weight="semibold">
                        {words.lead}
                    </Text>
                    {` ${words.body}`}
                </Text>
                {words.note ? (
                    <Text variant="caption" tone="secondary">
                        {words.note}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        banner: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: theme.spacing[2.5],
            padding: theme.spacing.md,
            borderRadius: theme.radii.sm,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.borderDefault,
            backgroundColor: theme.colors.bgPrimary,
        },
        body: { flex: 1, gap: theme.spacing.xs },
    });
