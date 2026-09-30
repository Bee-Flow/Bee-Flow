/**
 * One registry field as an input: text-ish kinds are a TextField, a switch is
 * a ToggleRow, a choice (fixed, server-listed or an org member) is a row of
 * pills. The value is always a string or a boolean — model/fields.ts turns it
 * into the body.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { TextField, ToggleRow } from '@/shared/ui';

import { ChoiceChips } from './ChoiceChips';
import { useOrgUsers, useRemoteChoices } from '../hooks/queries';
import { labelText } from '../model/fields';
import type { FieldSpec, FieldValue, Rec } from '../model/types';

export interface FieldInputProps {
    spec: FieldSpec;
    value: FieldValue | undefined;
    onChange: (next: FieldValue) => void;
    error?: string;
    /** The record being edited, for a server-listed choice. */
    rec?: Rec | null;
}

function RemoteChoice({ spec, value, onChange, error, rec }: FieldInputProps) {
    const t = useTranslation();
    const choices = useRemoteChoices(spec.remote ? spec.remote(rec ?? null) : null, true);
    return (
        <ChoiceChips
            testID={`field-${spec.key}`}
            label={labelText(spec.label, t)}
            options={(choices.data ?? []).map((c) => ({ value: c.value, label: labelText(c.label, t) }))}
            value={typeof value === 'string' ? value : ''}
            onChange={onChange}
            required={spec.required}
            hint={choices.data?.length === 0 ? t('compliance.conn_connection_none', 'No connection linked') : undefined}
            error={error}
        />
    );
}

function UserChoice({ spec, value, onChange, error }: FieldInputProps) {
    const t = useTranslation();
    const users = useOrgUsers(true);
    return (
        <ChoiceChips
            testID={`field-${spec.key}`}
            label={labelText(spec.label, t)}
            options={(users.data ?? []).map((u) => ({ value: u.id, label: u.displayName || u.id }))}
            value={typeof value === 'string' ? value : ''}
            onChange={onChange}
            required={spec.required}
            error={error}
        />
    );
}

const KEYBOARD = { number: 'numeric', email: 'email-address' } as const;

function TextInput({ spec, value, onChange, error }: FieldInputProps) {
    const t = useTranslation();
    const placeholder = spec.placeholder ? labelText(spec.placeholder, t) : undefined;
    return (
        <TextField
            testID={`field-${spec.key}`}
            label={labelText(spec.label, t)}
            hint={spec.hint ? labelText(spec.hint, t) : undefined}
            error={error}
            value={typeof value === 'string' ? value : ''}
            onChangeText={onChange}
            placeholder={spec.kind === 'date' ? t('mobile.compliance.date_placeholder', 'YYYY-MM-DD') : placeholder}
            multiline={spec.kind === 'multiline' || spec.kind === 'lines'}
            keyboardType={spec.kind === 'number' || spec.kind === 'email' ? KEYBOARD[spec.kind] : 'default'}
            autoCapitalize={spec.kind === 'email' ? 'none' : undefined}
        />
    );
}

function FixedChoice({ spec, value, onChange, error }: FieldInputProps) {
    const t = useTranslation();
    return (
        <ChoiceChips
            testID={`field-${spec.key}`}
            label={labelText(spec.label, t)}
            options={(spec.options ?? []).map((o) => ({ value: o.value, label: labelText(o.label, t) }))}
            value={typeof value === 'string' ? value : ''}
            onChange={onChange}
            required={spec.required}
            hint={spec.hint ? labelText(spec.hint, t) : undefined}
            error={error}
        />
    );
}

export function FieldInput(props: FieldInputProps) {
    const t = useTranslation();
    const { spec, value, onChange } = props;
    if (spec.kind === 'bool') {
        return (
            <ToggleRow
                testID={`field-${spec.key}`}
                label={labelText(spec.label, t)}
                description={spec.hint ? labelText(spec.hint, t) : undefined}
                value={value === true}
                onValueChange={onChange}
            />
        );
    }
    if (spec.kind === 'choice') return spec.remote ? <RemoteChoice {...props} /> : <FixedChoice {...props} />;
    if (spec.kind === 'user') return <UserChoice {...props} />;
    return <TextInput {...props} />;
}
