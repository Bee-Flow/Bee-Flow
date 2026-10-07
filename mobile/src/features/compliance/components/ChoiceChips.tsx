/**
 * A single choice as a wrapping row of pills under its label — inside a form
 * sheet, where a second sheet on top would be one modal too many. Pressing
 * the chosen pill again clears an optional choice. The selected option's own
 * hint, when it has one, is shown under the pills.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Text } from '@/shared/ui';

export interface ChipOption {
    value: string;
    label: string;
    /** Shown under the pills while this option is selected. */
    hint?: string;
}

export interface ChoiceChipsProps {
    label: string;
    options: readonly ChipOption[];
    value: string;
    onChange: (next: string) => void;
    required?: boolean;
    hint?: string;
    error?: string;
    testID?: string;
}

export function ChoiceChips({ label, options, value, onChange, required = false, hint, error, testID }: ChoiceChipsProps) {
    const styles = useThemedStyles(makeStyles);
    const note = options.find((o) => o.value === value)?.hint ?? hint;
    return (
        <View style={styles.field} testID={testID}>
            <Text variant="label" tone="secondary">
                {label}
            </Text>
            <View style={styles.row}>
                {options.map((o) => (
                    <Chip
                        key={o.value}
                        testID={testID ? `${testID}-${o.value}` : undefined}
                        label={o.label}
                        selected={o.value === value}
                        onPress={() => onChange(o.value === value && !required ? '' : o.value)}
                    />
                ))}
            </View>
            {error ? (
                <Text variant="label" tone="error">
                    {error}
                </Text>
            ) : note ? (
                <Text variant="label" tone="tertiary" testID={testID ? `${testID}-hint` : undefined}>
                    {note}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        field: { gap: theme.spacing[2], paddingVertical: theme.spacing[2] },
        row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] },
    });
