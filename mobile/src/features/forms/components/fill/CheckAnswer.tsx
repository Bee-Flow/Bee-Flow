/**
 * A yes/no question. A required one is a statement to agree to ("I have read
 * the policy"), which is why an unticked required box is "not answered".
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text, ToggleRow } from '@/shared/ui';

import { labelOf, type AnswerProps } from './types';

export function CheckAnswer({ field, value, error, disabled, onChange }: AnswerProps) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.box}>
            <ToggleRow
                label={labelOf(field)}
                description={field.help || undefined}
                value={value === true}
                onValueChange={onChange}
                disabled={disabled}
                gutter={false}
                testID={`fill-${field.name}`}
            />
            {error ? (
                <Text variant="caption" tone="error">
                    {error}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.xs } satisfies ViewStyle,
});
