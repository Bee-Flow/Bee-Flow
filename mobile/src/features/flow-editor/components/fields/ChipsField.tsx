/**
 * Several of a set — the web's pill toggles (a notification's channels, the
 * categories a Privacy Shield looks for). An option can be fixed on (the
 * in-app bell always rings) or unavailable.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip } from '@/shared/ui';

import { FieldRow } from './FieldRow';

export interface ChipOption {
    value: string;
    label: string;
    /** Always on; cannot be switched off. */
    fixed?: boolean;
    disabled?: boolean;
}

export function ChipsField({
    value,
    options,
    onChange,
    label,
    hint,
    disabled,
    testID,
}: {
    value: readonly string[];
    options: readonly ChipOption[];
    onChange: (next: string[]) => void;
    label?: string;
    hint?: string | null;
    disabled?: boolean;
    testID?: string;
}) {
    const styles = useThemedStyles(makeStyles);
    const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
    return (
        <FieldRow label={label} hint={hint} testID={testID}>
            <View style={styles.row}>
                {options.map((o) => (
                    <Chip
                        key={o.value}
                        label={o.label}
                        selected={o.fixed || value.includes(o.value)}
                        disabled={disabled || o.fixed || o.disabled}
                        onPress={() => toggle(o.value)}
                        testID={testID ? `${testID}-${o.value}` : undefined}
                    />
                ))}
            </View>
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[1.5] } satisfies ViewStyle,
});
