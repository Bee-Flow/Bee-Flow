/**
 * The one form sheet behind every register's create, edit and "ask first"
 * action: the registry's fields, validated as model/fields.ts says, submitted
 * as a FormValues object the caller turns into its body. Mount it only while
 * open — useForm keeps its first `initial`.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, useForm, type Validator } from '@/shared/patterns';

import { FieldInput } from './FieldInput';
import { validateFields } from '../model/fields';
import type { FieldSpec, FieldValue, FormValues, Rec } from '../model/types';

export interface RecordFormSheetProps {
    title: string;
    submitLabel: string;
    fields: readonly FieldSpec[];
    initial: FormValues;
    rec?: Rec | null;
    danger?: boolean;
    onClose: () => void;
    /** The work; a throw stays in the sheet as its error. */
    onSubmit: (values: FormValues) => Promise<unknown>;
}

export function RecordFormSheet({ title, submitLabel, fields, initial, rec, danger, onClose, onSubmit }: RecordFormSheetProps) {
    const t = useTranslation();
    const validate: Record<string, readonly Validator<FieldValue, FormValues>[]> = {};
    for (const spec of fields) validate[spec.key] = [(_v, values) => validateFields([spec], values, t)[spec.key] ?? null];
    const form = useForm<FormValues>({ initial, validate, onSubmit });

    const submit = async () => {
        if (await form.submit()) onClose();
    };

    return (
        <FormSheet
            visible
            onClose={onClose}
            title={title}
            submitLabel={submitLabel}
            onSubmit={() => void submit()}
            submitting={form.submitting}
            canSubmit={form.canSubmit}
            error={form.submitError}
            variant={danger ? 'danger' : 'primary'}
        >
            {fields.map((spec) => {
                const binding = form.field(spec.key);
                return (
                    <FieldInput
                        key={spec.key}
                        spec={spec}
                        value={binding.value}
                        onChange={binding.onChangeText}
                        error={binding.error}
                        rec={rec}
                    />
                );
            })}
        </FormSheet>
    );
}
