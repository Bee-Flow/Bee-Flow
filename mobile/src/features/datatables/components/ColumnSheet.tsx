/**
 * One column, added or changed — the web's ColumnDesigner row, as a sheet: the
 * name, the type, the options a list column needs, and whether it is required.
 *
 * The technical name follows the name for a NEW column and is fixed for an
 * existing one: the server matches a saved column by id first and key second,
 * and the key is what every routine step names. Removing a column and
 * changing its type are what destroy data, so they are confirmed by the caller
 * with the row count, not here.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, maxLength, required, useForm } from '@/shared/patterns';
import { Button, FilterPills, Text, TextField, ToggleRow } from '@/shared/ui';

import { COLUMN_TYPES, keyFromName, MAX_NAME_LEN, SYSTEM_COLUMNS } from '../model/columns';
import type { Column, ColumnDraft, ColumnType } from '../model/types';

interface Values extends Record<string, unknown> {
    name: string;
    type: ColumnType;
    options: string;
    required: boolean;
}

const needsOptions = (type: ColumnType) => type === 'select' || type === 'multiselect';

/** One option per line (a comma inside an option is allowed); blanks and repeats drop. */
export function parseOptions(text: string): string[] {
    return [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))];
}

function initialValues(column: Column | null): Values {
    const type = COLUMN_TYPES.some((c) => c.type === column?.type) ? (column?.type as ColumnType) : 'text';
    return { name: column?.name ?? '', type, options: (column?.options ?? []).join('\n'), required: column?.required ?? false };
}

export function ColumnSheet({
    column,
    takenKeys,
    busy,
    onClose,
    onSave,
    onDelete,
}: {
    /** The column being changed, or null for a new one. Mount per opening. */
    column: Column | null;
    /** Keys already used by the table's OTHER columns. */
    takenKeys: readonly string[];
    busy: boolean;
    onClose: () => void;
    onSave: (draft: ColumnDraft) => Promise<unknown>;
    onDelete?: () => void;
}) {
    const t = useTranslation();
    const form = useForm<Values>({
        initial: initialValues(column),
        validate: {
            name: [
                required(t('mobile.datatables.column_name_required', 'Give the column a name')),
                maxLength(MAX_NAME_LEN, t('mobile.datatables.name_too_long', 'A name may be at most 120 characters')),
                (v: unknown) => {
                    if (column) return null;
                    const key = keyFromName(v);
                    if (!key) return t('mobile.datatables.name_no_key', 'Use at least one letter or digit in the name');
                    if (SYSTEM_COLUMNS.includes(key)) return t('mobile.datatables.key_system', 'Every table already has a “{key}” column — choose another name', { key });
                    return takenKeys.includes(key) ? t('mobile.datatables.key_taken', 'There is already a column called “{key}”', { key }) : null;
                },
            ],
            options: [
                (v: unknown, all: Values) =>
                    needsOptions(all.type) && !parseOptions(String(v)).length
                        ? t('mobile.datatables.options_required', 'A list column needs at least one option')
                        : null,
            ],
        },
        onSubmit: (v) =>
            onSave({
                ...(column?.id ? { id: column.id } : {}),
                key: column ? column.key : keyFromName(v.name),
                name: v.name.trim(),
                type: v.type,
                ...(needsOptions(v.type) ? { options: parseOptions(v.options) } : {}),
                ...(v.required ? { required: true } : {}),
                ...(column?.unique ? { unique: true } : {}),
            }),
    });
    const name = form.field('name');
    const options = form.field('options');

    return (
        <FormSheet
            visible
            onClose={onClose}
            title={column ? t('mobile.datatables.column_edit', 'Change column') : t('datatables.column_add', 'Add a column')}
            submitLabel={t('mobile.datatables.column_save', 'Save column')}
            onSubmit={() => void form.submit()}
            submitting={busy || form.submitting}
            canSubmit={form.canSubmit && (form.dirty || !column)}
            error={form.submitError}
        >
            <TextField
                label={t('datatables.column_name', 'Column name')}
                value={name.value}
                onChangeText={name.onChangeText}
                error={name.error}
                hint={t('mobile.datatables.technical_name_is', 'Technical name: {key}', { key: column?.key ?? (keyFromName(name.value) || '—') })}
                testID="column-name"
            />
            <Text variant="label" tone="secondary">
                {t('datatables.column_type', 'Column type')}
            </Text>
            <FilterPills<ColumnType>
                value={form.values.type}
                onChange={(next) => form.set('type', next)}
                accessibilityLabel={t('datatables.column_type', 'Column type')}
                options={COLUMN_TYPES.map((c) => ({ value: c.type, label: t(c.key, c.fallback) }))}
                testID="column-type"
            />
            {needsOptions(form.values.type) ? (
                <TextField
                    label={t('mobile.datatables.options', 'Options')}
                    hint={t('mobile.datatables.options_hint', 'One option per line.')}
                    value={options.value}
                    onChangeText={options.onChangeText}
                    error={options.error}
                    multiline
                    testID="column-options"
                />
            ) : null}
            <ToggleRow
                label={t('mobile.datatables.required', 'Required')}
                description={t('mobile.datatables.required_hint', 'A row cannot be saved without a value here.')}
                value={form.values.required}
                onValueChange={(next) => form.set('required', next)}
                gutter={false}
            />
            {onDelete ? (
                <Button variant="danger" iconName="Trash2" label={t('mobile.datatables.column_remove', 'Remove this column')} onPress={onDelete} />
            ) : null}
        </FormSheet>
    );
}
