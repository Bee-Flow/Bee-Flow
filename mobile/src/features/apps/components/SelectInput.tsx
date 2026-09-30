/** A Studio select field as a row of chips — one tap per answer. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Text } from '@/shared/ui';

import type { AppInput } from '../model/inputs';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { gap: theme.spacing.sm },
        options: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    });

export function SelectInput({
    input,
    value,
    error,
    onChange,
}: {
    input: AppInput;
    value: string | number | boolean | null;
    error: string | null;
    onChange: (next: string) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.root}>
            <Text variant="caption" tone="secondary" weight="medium">
                {input.label}
                {input.required ? ' *' : ''}
            </Text>
            <View style={styles.options}>
                {input.options.map((option) => (
                    <Chip
                        key={option.value}
                        label={option.label}
                        selected={value === option.value}
                        onPress={() => onChange(option.value)}
                    />
                ))}
            </View>
            {error ? (
                <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                    {error}
                </Text>
            ) : null}
        </View>
    );
}
