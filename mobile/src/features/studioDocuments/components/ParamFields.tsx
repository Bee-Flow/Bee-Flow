/**
 * The small shared inputs of the contract editors: a parameter type picker,
 * a yes/no/unset picker, and a typed value field (number keyboard for a
 * number, the ISO date shape for a date).
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { FilterPills, Segmented, TextField } from '@/shared/ui';

import { paramTypeLabel } from '../model/format';
import { PARAM_TYPES, type ParamType } from '../model/types';
import { coerceInput, inputText } from '../model/values';

export function TypePicker({ value, nested, onChange }: { value: ParamType; nested?: boolean; onChange: (type: ParamType) => void }) {
    const t = useTranslation();
    const types = PARAM_TYPES.filter((type) => !nested || type !== 'list');
    return (
        <FilterPills
            value={value}
            onChange={onChange}
            options={types.map((type) => ({ value: type, label: paramTypeLabel(t, type) }))}
            accessibilityLabel={t('common.type', 'Type')}
        />
    );
}

type Tri = 'unset' | 'true' | 'false';

/** Yes, no, or nothing chosen (`undefined`). */
export function YesNoPicker({ value, onChange, label }: { value: unknown; onChange: (next: boolean | undefined) => void; label: string }) {
    const t = useTranslation();
    const current: Tri = value === true ? 'true' : value === false ? 'false' : 'unset';
    return (
        <Segmented<Tri>
            options={[
                { value: 'unset', label: '—' },
                { value: 'true', label: t('common.yes', 'Yes') },
                { value: 'false', label: t('common.no', 'No') },
            ]}
            value={current}
            onChange={(next) => onChange(next === 'unset' ? undefined : next === 'true')}
            accessibilityLabel={label}
            fullWidth
        />
    );
}

export interface TypedValueFieldProps {
    type: ParamType;
    label: string;
    value: unknown;
    onChange: (next: unknown) => void;
    hint?: string;
    editable?: boolean;
}

/**
 * A text, number or date value; '' clears it. The field keeps its own text so
 * a half-typed number ("1.") is not rewritten under the thumb.
 */
export function TypedValueField({ type, label, value, onChange, hint, editable = true }: TypedValueFieldProps) {
    const [text, setText] = useState(() => inputText(value));
    return (
        <TextField
            label={label}
            hint={hint ?? (type === 'date' ? 'YYYY-MM-DD' : undefined)}
            value={text}
            editable={editable}
            keyboardType={type === 'number' ? 'decimal-pad' : 'default'}
            autoCapitalize={type === 'text' ? 'sentences' : 'none'}
            onChangeText={(next) => {
                setText(next);
                onChange(coerceInput(type, next));
            }}
        />
    );
}
