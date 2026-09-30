/**
 * A short text with suggestions under it — the web's FieldKeyCombobox: the
 * keys of the chosen list's items, one tap each, and free typing for a key
 * the sample does not show yet.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { FieldRow } from '@/features/flow-editor/components/fields';
import { Chip, TextField } from '@/shared/ui';

export function SuggestText({
    value,
    onChange,
    suggestions,
    label,
    hint,
    prompt,
    required,
    disabled,
}: {
    value: string;
    onChange: (next: string) => void;
    suggestions: readonly string[];
    label?: string;
    hint?: string | null;
    prompt?: string;
    required?: boolean;
    disabled?: boolean;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <FieldRow label={label} hint={hint} required={required}>
            <TextField
                value={value}
                onChangeText={onChange}
                placeholder={prompt}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!disabled}
                accessibilityLabel={label}
            />
            {suggestions.length && !disabled ? (
                <View style={styles.row}>
                    {suggestions.slice(0, 12).map((s) => (
                        <Chip key={s} label={s} selected={s === value} onPress={() => onChange(s)} />
                    ))}
                </View>
            ) : null}
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[1.5] } satisfies ViewStyle,
});
