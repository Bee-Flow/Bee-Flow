/**
 * One registry field as an input: text-ish kinds are a TextField, a switch is
 * a ToggleRow, a fixed or server-listed choice is a row of pills, a member is
 * a searchable picker (one or several), a day is a DayField, a moment a
 * MomentField, a JSON object a multiline field. The field's own hint,
 * placeholder and options may depend on the record; a preview, a server
 * warning and a file import may sit under it (FieldExtras). model/fields.ts
 * turns the value into the body.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { TextField, ToggleRow } from '@/shared/ui';

import { ChoiceChips } from './ChoiceChips';
import { DayField } from './DayField';
import { FieldExtras } from './FieldExtras';
import { MemberField } from './MemberField';
import { MomentField } from './MomentField';
import { useRemoteChoices } from '../hooks/queries';
import { labelText } from '../model/fields';
import type { FieldSpec, FieldValue, Rec } from '../model/types';

export interface FieldInputProps {
    spec: FieldSpec;
    value: FieldValue | undefined;
    onChange: (next: FieldValue) => void;
    error?: string;
    /** The record being edited, for a server-listed choice and record-bound copy. */
    rec?: Rec | null;
}

const text = (value: FieldValue | undefined) => (typeof value === 'string' ? value : '');

/** The field's hint and placeholder, the record-bound ones first. */
function useCopy(spec: FieldSpec, rec: Rec | null | undefined) {
    const t = useTranslation();
    const hint = spec.hintFor?.(rec ?? null) ?? spec.hint;
    const placeholder = spec.placeholderFor?.(rec ?? null) ?? (spec.placeholder ? labelText(spec.placeholder, t) : undefined);
    return { t, label: labelText(spec.label, t), hint: hint ? labelText(hint, t) : undefined, placeholder };
}

function RemoteChoice({ spec, value, onChange, error, rec }: FieldInputProps) {
    const { t, label } = useCopy(spec, rec);
    const choices = useRemoteChoices(spec.remote ? spec.remote(rec ?? null) : null, true);
    return (
        <ChoiceChips
            testID={`field-${spec.key}`}
            label={label}
            options={(choices.data ?? []).map((c) => ({ value: c.value, label: labelText(c.label, t) }))}
            value={text(value)}
            onChange={onChange}
            required={spec.required}
            hint={choices.data?.length === 0 ? t('compliance.conn_connection_none', 'No connection linked') : undefined}
            error={error}
        />
    );
}

const KEYBOARD = { number: 'numeric', email: 'email-address' } as const;

function TextInput({ spec, value, onChange, error, rec }: FieldInputProps) {
    const { label, hint, placeholder } = useCopy(spec, rec);
    const long = spec.kind === 'multiline' || spec.kind === 'lines' || spec.kind === 'json';
    return (
        <TextField
            testID={`field-${spec.key}`}
            label={label}
            hint={hint}
            error={error}
            value={text(value)}
            onChangeText={onChange}
            placeholder={spec.kind === 'json' ? placeholder ?? '{ }' : placeholder}
            multiline={long}
            maxLines={spec.kind === 'json' ? 12 : undefined}
            keyboardType={spec.kind === 'number' || spec.kind === 'email' ? KEYBOARD[spec.kind] : 'default'}
            autoCapitalize={spec.kind === 'email' || spec.kind === 'json' ? 'none' : undefined}
            autoCorrect={spec.kind === 'json' ? false : undefined}
        />
    );
}

function FixedChoice({ spec, value, onChange, error, rec }: FieldInputProps) {
    const { t, label, hint } = useCopy(spec, rec);
    const options = spec.optionsFor ? spec.optionsFor(rec ?? null) : spec.options ?? [];
    return (
        <ChoiceChips
            testID={`field-${spec.key}`}
            label={label}
            options={options.map((o) => ({ value: o.value, label: labelText(o.label, t), hint: o.hint ? labelText(o.hint, t) : undefined }))}
            value={text(value)}
            onChange={onChange}
            required={spec.required}
            hint={hint}
            error={error}
        />
    );
}

function Input(props: FieldInputProps) {
    const { spec, value, onChange, error, rec } = props;
    const { label, hint } = useCopy(spec, rec);
    const common = { testID: `field-${spec.key}`, label, hint, error, required: spec.required };
    switch (spec.kind) {
        case 'bool':
            return <ToggleRow testID={common.testID} label={label} description={hint} value={value === true} onValueChange={onChange} />;
        case 'choice':
            return spec.remote ? <RemoteChoice {...props} /> : <FixedChoice {...props} />;
        case 'user':
        case 'users':
            return <MemberField {...common} multi={spec.kind === 'users'} value={Array.isArray(value) ? value : text(value)} onChange={onChange} />;
        case 'date':
            return <DayField {...common} value={text(value)} onChange={onChange} />;
        case 'moment':
            return <MomentField {...common} value={text(value)} onChange={onChange} />;
        default:
            return <TextInput {...props} />;
    }
}

export function FieldInput(props: FieldInputProps) {
    return (
        <>
            <Input {...props} />
            <FieldExtras spec={props.spec} value={props.value} onChange={props.onChange} />
        </>
    );
}
