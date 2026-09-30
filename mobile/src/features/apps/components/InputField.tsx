/** One field of a Studio form, drawn as the phone's own input for its type. */

import React, { useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Chip, TextField } from '@/shared/ui';

import { DateInput } from './DateInput';
import { SelectInput } from './SelectInput';
import { isEmptyValue, numberAnswer, type AppInput } from '../model/inputs';

type Value = string | number | boolean | null;

function keyboardFor(inputType: AppInput['inputType']): 'email-address' | 'url' | 'default' {
    if (inputType === 'email') return 'email-address';
    if (inputType === 'url') return 'url';
    return 'default';
}

function errorOf(t: TranslateFn, input: AppInput, value: Value): string | null {
    if (input.required && isEmptyValue(input, value)) return t('mobile.apps.field_required', 'This one is required.');
    if (input.type === 'input_number' && typeof value === 'string') return t('mobile.apps.enter_number', 'Enter a number.');
    return null;
}

/** What every field kind shows: the error once due, the label, the text, the placeholder. */
function fieldState(t: TranslateFn, input: AppInput, value: Value, showError: boolean) {
    return {
        error: showError ? errorOf(t, input, value) : null,
        label: input.required ? `${input.label} *` : input.label,
        text: value === null || value === undefined ? '' : String(value),
        placeholder: input.placeholder ?? undefined,
    };
}

function rangeHint(t: TranslateFn, input: AppInput): string | undefined {
    if (input.min === null && input.max === null) return undefined;
    return t('mobile.apps.number_range', 'Between {min} and {max}', { min: input.min ?? '−∞', max: input.max ?? '∞' });
}

/**
 * A number. While it has focus the field shows what was typed, so "1," and
 * "0.0" survive on the way to "1,5" and "0.05"; the form gets the number once
 * the text is one, with a dot or a decimal comma. Leaving the field shows the
 * form's value again.
 */
function NumberInput({ input, label, text, error, onChange }: { input: AppInput; label: string; text: string; error: string | null; onChange: (next: Value) => void }) {
    const t = useTranslation();
    const [typed, setTyped] = useState<string | null>(null);
    return (
        <TextField
            label={label}
            value={typed ?? text}
            onChangeText={(next) => {
                setTyped(next);
                onChange(numberAnswer(next));
            }}
            onBlur={() => setTyped(null)}
            keyboardType="numeric"
            error={error}
            hint={rangeHint(t, input)}
            testID={`app-input-${input.name}`}
        />
    );
}

export function InputField({
    input,
    value,
    showError,
    onChange,
}: {
    input: AppInput;
    value: Value;
    showError: boolean;
    onChange: (next: Value) => void;
}) {
    const t = useTranslation();
    const { error, label, text, placeholder } = fieldState(t, input, value, showError);

    switch (input.type) {
        case 'input_checkbox':
            return <Chip label={input.label} selected={value === true} onPress={() => onChange(value !== true)} />;
        case 'input_select':
            return <SelectInput input={input} value={value} error={error} onChange={onChange} />;
        case 'input_number':
            return <NumberInput input={input} label={label} text={text} error={error} onChange={onChange} />;
        case 'input_date':
            return <DateInput label={label} value={value} error={error} onChange={onChange} />;
        case 'input_textarea':
            return (
                <TextField
                    label={label}
                    value={text}
                    onChangeText={(next) => onChange(next || null)}
                    placeholder={placeholder}
                    multiline
                    maxLines={Math.min(8, Math.max(3, input.rows))}
                    error={error}
                />
            );
        case 'input_text':
        default:
            return (
                <TextField
                    label={label}
                    value={text}
                    onChangeText={(next) => onChange(next || null)}
                    placeholder={placeholder}
                    keyboardType={keyboardFor(input.inputType)}
                    autoCapitalize={input.inputType === 'text' ? 'sentences' : 'none'}
                    error={error}
                />
            );
    }
}
