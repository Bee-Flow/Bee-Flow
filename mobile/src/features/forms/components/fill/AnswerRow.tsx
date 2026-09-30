/**
 * One question on the page: its label, the answer control, the question's
 * help and — last, and announced when it appears — what is wrong with the
 * answer. Every answer control that draws its own control wears it, so the
 * parts sit in the same order everywhere and an error is never silent to a
 * screen reader (the flow editor's FieldRow does the same for a step's
 * settings).
 */

import React, { type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

export interface AnswerRowProps {
    label?: string | null;
    help?: string | null;
    error?: string | null;
    /** A handed-over file sits closer to its label than a control does. */
    tight?: boolean;
    children: ReactNode;
}

export function AnswerRow({ label, help, error, tight = false, children }: AnswerRowProps) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={tight ? styles.tight : styles.box}>
            {label ? (
                <Text variant="label" tone="secondary">
                    {label}
                </Text>
            ) : null}
            {children}
            {help ? (
                <Text variant="caption" tone="tertiary">
                    {help}
                </Text>
            ) : null}
            {error ? (
                <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                    {error}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.sm } satisfies ViewStyle,
    tight: { gap: theme.spacing.xs } satisfies ViewStyle,
});
