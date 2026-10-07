/**
 * The one form sheet behind every register's create, edit and "ask first"
 * action: the registry's fields, validated as model/fields.ts says (plus the
 * caller's cross-field rules), submitted as a FormValues object the caller
 * turns into its body. A field whose `visible()` says false is hidden and not
 * validated. Mount it only while open — useForm keeps its first `initial`.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, useForm, type Validator } from '@/shared/patterns';

import { FieldInput } from './FieldInput';
import { isVisible, validateFields } from '../model/fields';
import type { FieldSpec, FieldValue, FormValues, Rec } from '../model/types';

export interface RecordFormSheetProps {
    title: string;
    /** Under the title (the action's or create form's description). */
    subtitle?: string;
    submitLabel: string;
    fields: readonly FieldSpec[];
    initial: FormValues;
    rec?: Rec | null;
    danger?: boolean;
    /** Cross-field rules: field key → message. */
    validate?: (values: FormValues) => Record<string, string>;
    onClose: () => void;
    /** The work; a throw stays in the sheet as its error. */
    onSubmit: (values: FormValues) => Promise<unknown>;
}

export function RecordFormSheet({ title, subtitle, submitLabel, fields, initial, rec, danger, validate: cross, onClose, onSubmit }: RecordFormSheetProps) {
    const t = useTranslation();
    const ctx = { rec: rec ?? null };
    const validate: Record<string, readonly Validator<FieldValue, FormValues>[]> = {};
    for (const spec of fields) {
        validate[spec.key] = [
            (_v, values) => validateFields([spec], values, t, ctx)[spec.key] ?? (isVisible(spec, ctx.rec, values) ? cross?.(values)[spec.key] ?? null : null),
        ];
    }
    const form = useForm<FormValues>({ initial, validate, onSubmit });

    const submit = async () => {
        if (await form.submit()) onClose();
    };

    return (
        <FormSheet
            visible
            onClose={onClose}
            title={title}
            subtitle={subtitle}
            submitLabel={submitLabel}
            onSubmit={() => void submit()}
            submitting={form.submitting}
            canSubmit={form.canSubmit}
            error={form.submitError}
            variant={danger ? 'danger' : 'primary'}
        >
            {fields
                .filter((spec) => isVisible(spec, ctx.rec, form.values))
                .map((spec) => {
                    const binding = form.field(spec.key);
                    return <FieldInput key={spec.key} spec={spec} value={binding.value} onChange={binding.onChangeText} error={binding.error} rec={rec} />;
                })}
        </FormSheet>
    );
}
