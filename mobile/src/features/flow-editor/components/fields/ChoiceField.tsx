/**
 * One of a few choices that each need a sentence to explain — the web's
 * stacked option buttons (the Privacy Shield's "What should this step do?"):
 * every option on screen with its blurb, the chosen one marked.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { OptionRow } from '@/shared/ui';

import { FieldRow } from './FieldRow';
import type { SelectOption } from './SelectField';

export function ChoiceField({
    value,
    options,
    onChange,
    label,
    hint,
    disabled,
    testID,
}: {
    value: string;
    options: readonly SelectOption[];
    onChange: (next: string) => void;
    label?: string;
    hint?: string | null;
    disabled?: boolean;
    testID?: string;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <FieldRow label={label} hint={hint} testID={testID}>
            <View style={styles.card} accessibilityRole="radiogroup" accessibilityLabel={label}>
                {options.map((o) => (
                    <OptionRow
                        key={o.value}
                        label={o.label}
                        description={o.description}
                        selected={o.value === value}
                        disabled={disabled || o.disabled}
                        onPress={() => o.value !== value && onChange(o.value)}
                        testID={testID ? `${testID}-${o.value}` : undefined}
                    />
                ))}
            </View>
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    card: {
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.bgCard,
        overflow: 'hidden',
    } satisfies ViewStyle,
});
