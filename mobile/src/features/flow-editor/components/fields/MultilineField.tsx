/**
 * Plain text over several lines, with no data in it — instructions to a
 * model, a note on the canvas. A text that takes `{{ }}` data is a
 * BindingInput in template mode instead. With `maxLength` the count shows
 * under the field, as the server will cut there.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { TextField } from '@/shared/ui';

import { FieldRow } from './FieldRow';

export function MultilineField({
    value,
    onChange,
    label,
    hint,
    prompt,
    required,
    error,
    maxLength,
    lines = 6,
    disabled = false,
    testID,
}: {
    value: unknown;
    onChange: (next: string) => void;
    label?: string;
    hint?: string | null;
    prompt?: string;
    required?: boolean;
    error?: string | null;
    maxLength?: number;
    lines?: number;
    /** Read-only while the automation is locked (the AI builder holds it). */
    disabled?: boolean;
    testID?: string;
}) {
    const t = useTranslation();
    const text = typeof value === 'string' ? value : '';
    const count = maxLength ? t('mobile.flow.field.count', '{n} of {max}', { n: text.length, max: maxLength }) : null;
    return (
        <FieldRow label={label} hint={count ? [hint, count].filter(Boolean).join(' · ') : hint} required={required} error={error} testID={testID}>
            <TextField
                value={text}
                onChangeText={onChange}
                multiline
                maxLines={lines}
                maxLength={maxLength}
                placeholder={prompt}
                editable={!disabled}
                accessibilityLabel={label}
                testID={testID ? `${testID}-input` : undefined}
            />
        </FieldRow>
    );
}
