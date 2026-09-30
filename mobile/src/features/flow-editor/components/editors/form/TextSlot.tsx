/**
 * One text slot of a form page. On a LATER page (`allowVariables`) it is a
 * template field — "Insert data" and `{{…}}` pills — because the server
 * fills it in when the page is shown; on page one it is plain text, because
 * nothing has run yet and a `{{…}}` would reach the visitor verbatim.
 */

import React from 'react';

import { BindingInput, MultilineField } from '@/features/flow-editor/components/fields';
import { TextField } from '@/shared/ui';

export interface TextSlotProps {
    value: unknown;
    onChange: (next: string) => void;
    allowVariables: boolean;
    label?: string;
    hint?: string | null;
    placeholder?: string;
    multiline?: boolean;
    disabled?: boolean;
    testID?: string;
}

export function TextSlot({ value, onChange, allowVariables, label, hint, placeholder, multiline = false, disabled = false, testID }: TextSlotProps) {
    const text = typeof value === 'string' ? value : '';
    if (allowVariables) {
        return (
            <BindingInput
                mode="template"
                value={text}
                onChange={(v) => onChange(String(v ?? ''))}
                label={label}
                hint={hint}
                prompt={placeholder}
                multiline={multiline}
                disabled={disabled}
                testID={testID}
            />
        );
    }
    if (multiline) {
        return <MultilineField value={text} onChange={onChange} label={label} hint={hint} prompt={placeholder} lines={3} testID={testID} />;
    }
    return (
        <TextField
            value={text}
            onChangeText={onChange}
            label={label}
            hint={hint ?? undefined}
            placeholder={placeholder}
            editable={!disabled}
            testID={testID}
        />
    );
}
