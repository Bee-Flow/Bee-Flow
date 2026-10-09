/**
 * The datatable step — the web's DatatableFields (datatableEditors.jsx):
 * which table, what to do with it, which rows, and what to write. Rows in a
 * datatable outlive the run, so a later run (or another automation) reads what
 * this one wrote. Nothing is free text but the values.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { BindingInput, NumberField, SelectField } from '@/features/flow-editor/components/fields';

import { opChoices, opNeeds, setSort, sortEntry, tableOption, type WhereRow } from './datatableModel';
import { WhereList } from './WhereList';
import { SuggestText } from '../declarative/rows/SuggestText';
import { say } from '../declarative/runtime';
import { FOR_EACH, repeatsOrRetries, RETRY } from '../declarative/specs/common';
import { Band } from '../shared/Band';
import { listOf, recordOf } from '../shared/list';
import { Note } from '../shared/Note';
import { SpecFields } from '../shared/SpecFields';
import { Warn } from '../shared/Warn';
import type { StepEditorProps } from '../types';

/** The example column in the empty "Match on" box: an identifier, not copy. */
const MATCH_EXAMPLE = 'email';

function TableBand({ editor, writes }: { editor: StepEditorProps; writes: boolean }) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const tables = ctx.catalog?.datatables ?? [];
    const ops = opChoices(ctx.catalog?.datatableOps ?? []);
    const op = typeof draft.op === 'string' && draft.op ? draft.op : 'find_rows';
    const table = tables.find((x) => x.id === draft.datatableId) ?? null;
    return (
        <Band editor={editor} sectionKey="table" title={t('mobile.flow.datatable.table', 'Table')} defaultOpen>
            {tables.length === 0 ? (
                <Note>
                    {t(
                        'mobile.flow.datatable.none_yet',
                        'No datatables yet. You can make one yourself in Studio → Datatables — a table for this account alone needs no permission; one the whole organisation can use needs a permission an administrator grants. It appears in this list as soon as it exists.',
                    )}
                </Note>
            ) : (
                <SelectField
                    label={t('automations.node.datatable.typeLabel', 'Datatable')}
                    hint={t('automations.datatable_editors.rows_in_a_datatable_stay_put', 'Rows in a datatable stay put after the run ends, so this automation can read back what an earlier run wrote — and other automations can use the same table.')}
                    value={typeof draft.datatableId === 'string' ? draft.datatableId : ''}
                    prompt={t('automations.datatable_editors.pick_a_table', 'Pick a table…')}
                    options={tables.map((x) => {
                        const o = tableOption(x, writes);
                        return { value: o.value, label: o.label, description: o.notes.map((n) => say(t, n)).join(' · ') || undefined, disabled: o.disabled };
                    })}
                    onChange={(id) => set('datatableId', id)}
                    disabled={ctx.disabled}
                    testID="datatable-table"
                />
            )}
            <SelectField
                label={t('automations.datatable_editors.what_to_do', 'What to do')}
                hint={ops.find((o) => o.op === op)?.blurb || null}
                value={op}
                options={ops.map((o) => ({ value: o.op, label: say(t, o.label) }))}
                onChange={(next) => set('op', next)}
                disabled={ctx.disabled}
                testID="datatable-op"
            />
            {table && table.scope !== 'personal' && writes ? <Warn>{t('automations.datatable_editors.this_table_is_shared_other_people', 'This table is shared — other people and other automations read what this step writes.')}</Warn> : null}
        </Band>
    );
}

function FindOptions({ editor, columnKeys }: { editor: StepEditorProps; columnKeys: string[] }) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const sort = sortEntry(draft.sort);
    return (
        <>
            <SuggestText
                label={t('automations.datatable_editors.order_by', 'Order by')}
                hint={t('automations.datatable_editors.one_column_decides_the_order_rows', 'One column decides the order; rows with the same value fall back to the order they were added. Newest first when left empty.')}
                value={sort?.field ?? ''}
                onChange={(field) => set('sort', setSort(field, sort?.dir))}
                suggestions={columnKeys}
                prompt={t('automations.datatable_editors.added_on_default', 'added on (default)')}
                disabled={ctx.disabled}
            />
            {sort ? (
                <SelectField
                    value={sort.dir}
                    options={[
                        { value: 'desc', label: t('automations.datatable_editors.highest_first', 'highest first') },
                        { value: 'asc', label: t('automations.datatable_editors.lowest_first', 'lowest first') },
                    ]}
                    onChange={(dir) => set('sort', setSort(sort.field, dir))}
                    disabled={ctx.disabled}
                />
            ) : null}
            <NumberField
                label={t('automations.datatable_editors.at_most', 'At most')}
                hint={t('automations.datatable_editors.how_many_rows_one_page_brings', 'How many rows ONE page brings back. The default is 50; the step also hands back a cursor so a later step can read the next page.')}
                value={draft.limit ?? 50}
                onChange={(limit) => set('limit', limit === '' ? 50 : limit)}
                min={1}
                max={1000}
                integer
                disabled={ctx.disabled}
            />
        </>
    );
}

function Values({ editor, columns }: { editor: StepEditorProps; columns: readonly { key: string; name?: string }[] }) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const values = recordOf(draft.values);
    return (
        <Band editor={editor} sectionKey="values" title={t('automations.datatable_editors.what_to_write', 'What to write')} defaultOpen>
            {columns.length === 0 ? <Note>{t('automations.datatable_editors.pick_a_table_first_its_columns', 'Pick a table first — its columns appear here.')}</Note> : null}
            {columns.map((c) => (
                <BindingInput
                    key={c.key}
                    label={c.name || c.key}
                    value={values[c.key]}
                    onChange={(v) => set('values', { ...values, [c.key]: v })}
                    prompt={t('automations.ndv.tables_row.leave_empty', 'leave empty to skip {column}', { column: c.name || c.key })}
                    disabled={ctx.disabled}
                    testID={`datatable-value-${c.key}`}
                />
            ))}
        </Band>
    );
}

export function DatatableEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const op = typeof draft.op === 'string' && draft.op ? draft.op : 'find_rows';
    const needs = opNeeds(op);
    const table = (ctx.catalog?.datatables ?? []).find((x) => x.id === draft.datatableId) ?? null;
    const columns = table?.columns ?? [];
    const where = listOf<WhereRow>(draft.where);
    return (
        <>
            <TableBand editor={editor} writes={needs.writes} />
            <Band
                editor={editor}
                sectionKey="match"
                title={needs.where ? t('mobile.flow.datatable.which_rows_required', 'Which rows (required)') : t('mobile.flow.datatable.which_rows', 'Which rows')}
                defaultOpen={needs.where || where.length > 0}
            >
                {needs.match ? (
                    <SuggestText
                        label={t('automations.versions.setting.matchColumn', 'Match on')}
                        hint={t('automations.datatable_editors.the_column_that_decides_whether_a', 'The column that decides whether a row already exists. If a row has the same value here it is updated; otherwise a new row is added.')}
                        value={typeof draft.matchColumn === 'string' ? draft.matchColumn : ''}
                        onChange={(v) => set('matchColumn', v)}
                        suggestions={columns.map((c) => c.key)}
                        prompt={MATCH_EXAMPLE}
                        disabled={ctx.disabled}
                    />
                ) : null}
                <WhereList where={where} onChange={(next) => set('where', next)} columns={columns} required={needs.where} match={String(draft.match ?? 'all')} onMatch={(m) => set('match', m)} disabled={ctx.disabled} />
                {op === 'find_rows' ? <FindOptions editor={editor} columnKeys={columns.map((c) => c.key)} /> : null}
            </Band>
            {needs.values ? <Values editor={editor} columns={columns} /> : null}
            <Band editor={editor} sectionKey="advanced" title={t('mobile.flow.section.advanced', 'Advanced')} hasContent={repeatsOrRetries(draft, { ...ctx, step: editor.step })}>
                <Note>{t('mobile.flow.datatable.iteration_hint', 'Off by default: the step runs once. Turn on to run it once per item of an upstream list (then pick the item’s fields with Insert data, under Current item, in the conditions and values).')}</Note>
                <SpecFields editor={editor} fields={[FOR_EACH, RETRY]} />
            </Band>
        </>
    );
}
