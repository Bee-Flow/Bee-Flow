/**
 * A section-sized failure. Compact on purpose: five stacked full ErrorStates
 * on one screen is a wall of red that says nothing about which part still
 * works, and on this hub the other sections usually do.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        box: { padding: theme.spacing.lg, gap: theme.spacing.sm },
        title: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        retry: { minHeight: 40, justifyContent: 'center' },
    });

export function HubSectionProblem({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { title, message, retryable } = describeError(error);
    return (
        <View style={styles.box}>
            <View style={styles.title}>
                <Icon name="CircleAlert" size={16} color={theme.colors.error} />
                <Text variant="caption" weight="medium">
                    {title}
                </Text>
            </View>
            <Text variant="caption" tone="tertiary">
                {message}
            </Text>
            {retryable && onRetry ? (
                <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Try again" style={styles.retry}>
                    <Text variant="caption" tone="accent" weight="medium">
                        Try again
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}
