/**
 * Centred spinner for a screen that has nothing to show yet.
 *
 * One of the four states every data screen has (loading, empty, error,
 * offline). Each says what is happening; a label is worth adding when the wait
 * is longer than a blink.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { feedbackStyles } from './feedbackStyles';
import { Spinner } from './Spinner';
import { Text } from './Text';

export function LoadingState({ label }: { /** Optional caption under the spinner. */ label?: string }) {
    const theme = useTheme();
    return (
        <View style={[feedbackStyles.centre, { gap: theme.spacing.md, padding: theme.spacing.xl }]}>
            <Spinner size="large" />
            {label ? (
                <Text variant="caption" tone="tertiary" center>
                    {label}
                </Text>
            ) : null}
        </View>
    );
}
