/** One block of reasoning: its words, or — redacted by the provider — a lock saying so. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ThinkingPart } from '@/features/chat/model/types';
import { Icon, Text } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    divider: { borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, marginTop: theme.spacing.sm, paddingTop: theme.spacing.sm },
    redacted: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.sm, paddingVertical: theme.spacing.sm },
    phase: { marginBottom: theme.spacing.xs },
    text: { fontStyle: 'italic' as const },
});

export function ThinkingPartView({ part, divider, live }: { part: ThinkingPart; divider: boolean; live: boolean }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);

    if (part.redacted && !part.text) {
        return (
            <View style={[styles.redacted, divider ? styles.divider : null]}>
                <Icon name="Lock" size={12} color={theme.colors.textMuted} />
                <Text variant="caption" tone="tertiary" style={styles.text}>
                    {t('chat.msg.think_hidden_by_provider', 'Thinking summary hidden by provider')}
                </Text>
            </View>
        );
    }
    return (
        <View style={divider ? styles.divider : null}>
            {part.phase ? (
                <Text variant="label" tone="accent" style={styles.phase}>
                    {part.phase.toUpperCase()}
                </Text>
            ) : null}
            <Text variant="caption" tone="secondary" style={styles.text} selectable>
                {part.text}
                {live ? ' ▍' : ''}
            </Text>
        </View>
    );
}
