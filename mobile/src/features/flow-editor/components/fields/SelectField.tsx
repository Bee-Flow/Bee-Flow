/**
 * One choice from a list — the web's `<select>`, as a field that opens a
 * sheet of options (each with its one-line explanation where it has one). A
 * stored value that is not among the options is shown as itself rather than
 * snapped to a neighbour: opening a step is not consent to rewrite it.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { OptionRow, Sheet } from '@/shared/ui';

import { FieldRow } from './FieldRow';
import { SelectTrigger } from './SelectTrigger';

export interface SelectOption {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
}

export interface SelectFieldProps {
    value: string;
    options: readonly SelectOption[];
    onChange: (next: string) => void;
    label?: string;
    hint?: string | null;
    required?: boolean;
    error?: string | null;
    /** What the field says while nothing is chosen. */
    prompt?: string;
    disabled?: boolean;
    testID?: string;
}

export function SelectField({ value, options, onChange, label, hint, required, error, prompt, disabled = false, testID }: SelectFieldProps) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const [open, setOpen] = useState(false);
    const current = options.find((o) => o.value === value);
    const shown = current?.label ?? (value || prompt || t('mobile.flow.field.choose', 'Choose…'));
    const choose = (next: string) => {
        setOpen(false);
        if (next !== value) onChange(next);
    };
    return (
        <FieldRow label={label} hint={hint} required={required} error={error} testID={testID}>
            <SelectTrigger
                shown={shown}
                chosen={Boolean(current || value)}
                onPress={() => setOpen(true)}
                label={label}
                open={open}
                disabled={disabled}
                testID={testID ? `${testID}-select` : undefined}
            />
            <Sheet visible={open} onClose={() => setOpen(false)} title={label ?? t('mobile.flow.field.choose', 'Choose…')}>
                <View style={styles.list}>
                    {options.map((o) => (
                        <OptionRow
                            key={o.value}
                            label={o.label}
                            description={o.description}
                            selected={o.value === value}
                            disabled={o.disabled}
                            onPress={() => choose(o.value)}
                            testID={testID ? `${testID}-option-${o.value || 'none'}` : undefined}
                        />
                    ))}
                </View>
            </Sheet>
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    list: { marginHorizontal: -theme.spacing[5] } satisfies ViewStyle,
});
