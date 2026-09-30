/**
 * A number. While the field has focus the author's own text wins: clamping on
 * every keystroke is what made the web's fields impossible to clear and
 * retype (BFSF-345 — emptying one gave 0, which snapped straight back to the
 * minimum). A valid number is sent as it is typed, within its bounds; leaving
 * the field shows the stored value again. Blank is a value only where the
 * step allows it (an optional cap), and is then sent as ''.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text, TextField } from '@/shared/ui';

import { FieldRow } from './FieldRow';

export interface NumberFieldProps {
    value: unknown;
    onChange: (next: number | '') => void;
    label?: string;
    hint?: string | null;
    required?: boolean;
    error?: string | null;
    prompt?: string;
    min?: number;
    max?: number;
    integer?: boolean;
    /** An empty field is a value ('' — "the default"), not a typo. */
    allowBlank?: boolean;
    /** A unit after the field ("days"). */
    suffix?: string;
    /** Read-only (the AI builder holds the draft). */
    disabled?: boolean;
    testID?: string;
}

/** The typed text as a number within bounds, '' for a permitted blank, or null for "not yet a number". */
export function parseNumberInput(raw: string, { min, max, integer, allowBlank }: Pick<NumberFieldProps, 'min' | 'max' | 'integer' | 'allowBlank'>): number | '' | null {
    const text = raw.trim().replace(',', '.');
    if (!text) return allowBlank ? '' : null;
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    let out = integer ? Math.round(n) : n;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return out;
}

export function NumberField(props: NumberFieldProps) {
    const { value, onChange, label, hint, required, error, prompt, suffix, disabled = false, testID } = props;
    const styles = useThemedStyles(makeStyles);
    const [typed, setTyped] = useState<string | null>(null);
    const stored = value === '' || value === null || value === undefined ? '' : String(value);
    const onText = (raw: string) => {
        setTyped(raw);
        const next = parseNumberInput(raw, props);
        if (next !== null) onChange(next);
    };
    return (
        <FieldRow label={label} hint={hint} required={required} error={error} testID={testID}>
            <View style={styles.row}>
                <TextField
                    value={typed ?? stored}
                    onChangeText={onText}
                    onBlur={() => setTyped(null)}
                    editable={!disabled}
                    keyboardType={props.integer ? 'number-pad' : 'decimal-pad'}
                    placeholder={prompt}
                    accessibilityLabel={label}
                    containerStyle={styles.input}
                    testID={testID ? `${testID}-input` : undefined}
                />
                {suffix ? (
                    <Text variant="caption" tone="secondary">
                        {suffix}
                    </Text>
                ) : null}
            </View>
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    input: { flex: 1 } satisfies ViewStyle,
});
