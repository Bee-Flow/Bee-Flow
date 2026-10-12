/**
 * "Which rows" — the datatable step's conditions (datatableEditors.jsx): a
 * column from the table's own, a test narrowed by that column's type, and a
 * value that is a binding (none for "is empty"). A write that changes rows
 * must have at least one condition, or it would change every row.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { BindingInput, SelectField } from '@/features/flow-editor/components/fields';

import { newCondition, opsForType, opTakesNoValue, type WhereRow } from './datatableModel';
import { SuggestText } from '../declarative/rows/SuggestText';
import { say } from '../declarative/runtime';
import { AddButton } from '../shared/AddButton';
import { patchAt, removeAt } from '../shared/list';
import { RowCard } from '../shared/RowCard';
import { Warn } from '../shared/Warn';

export interface WhereListProps {
    where: WhereRow[];
    onChange: (next: WhereRow[]) => void;
    columns: readonly { key: string; name?: string; type?: string }[];
    required: boolean;
    match: string;
    onMatch: (match: string) => void;
    disabled: boolean;
}

export function WhereList({ where, onChange, columns, required, match, onMatch, disabled }: WhereListProps) {
    const t = useTranslation();
    const keys = columns.map((c) => c.key);
    const typeOf = (key: unknown) => columns.find((c) => c.key === key)?.type ?? null;
    return (
        <>
            {required && where.length === 0 ? <Warn tone="error">{t('automations.datatable_editors.add_at_least_one_condition_without', 'Add at least one condition. Without one this would change every row in the table.')}</Warn> : null}
            {where.length > 1 ? (
                <SelectField
                    label={t('automations.datatable_editors.combine_with', 'Combine with')}
                    hint={
                        required
                            ? t('mobile.flow.datatable.combine_write_hint', 'With "any", a row is changed when it matches ONE of these — a single broad condition then decides the whole write.')
                            : t('mobile.flow.datatable.combine_hint', 'All of them (the default), or any one of them.')
                    }
                    value={match === 'any' ? 'any' : 'all'}
                    options={[
                        { value: 'all', label: t('automations.datatable_editors.all_of_these_conditions', 'All of these conditions') },
                        { value: 'any', label: t('automations.datatable_editors.any_one_of_these_conditions', 'Any one of these conditions') },
                    ]}
                    onChange={(v) => onMatch(v === 'any' ? 'any' : 'all')}
                    disabled={disabled}
                />
            ) : null}
            {where.map((w, i) => (
                <RowCard
                    key={i}
                    title={w.field || t('automations.datatable_editors.column_2', 'Column')}
                    onRemove={() => onChange(removeAt(where, i))}
                    removeLabel={t('automations.datatable_editors.remove_this_condition', 'Remove this condition')}
                    disabled={disabled}
                    testID={`datatable-where-${i + 1}`}
                >
                    <SuggestText value={w.field || ''} onChange={(field) => onChange(patchAt(where, i, { field }))} suggestions={keys} label={t('automations.datatable_editors.column_2', 'Column')} disabled={disabled} />
                    <SelectField
                        value={w.op || 'eq'}
                        options={opsForType(typeOf(w.field)).map((o) => ({ value: o.op, label: say(t, o.label) }))}
                        onChange={(op) => onChange(patchAt(where, i, { op }))}
                        disabled={disabled}
                    />
                    {opTakesNoValue(w.op) ? null : (
                        <BindingInput
                            label={t('mobile.flow.datatable.value', 'Value')}
                            value={w.value}
                            onChange={(value) => onChange(patchAt(where, i, { value }))}
                            prompt={t('mobile.flow.datatable.value_placeholder', 'a value, or pick one from an earlier step')}
                            disabled={disabled}
                        />
                    )}
                </RowCard>
            ))}
            <AddButton label={t('mobile.flow.datatable.add_condition', 'Add a condition')} onPress={() => onChange([...where, newCondition()])} disabled={disabled} testID="datatable-where-add" />
        </>
    );
}
