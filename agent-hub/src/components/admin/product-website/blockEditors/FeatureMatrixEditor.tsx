import React from 'react';
import { TextField, Toggle, RepeatableList } from '../fields';
import { InlineHint, FieldSelect, SectionDivider } from '../primitives';
import type { BlockEditorProps } from './editorProps';
import { set, SectionHeaderFields } from './shared';
import type { SectionHeaderData } from './shared';
import { useTranslation } from '@/hooks/useTranslation';
import { MATRIX_COLUMNS_MAX, alignCells, blankCell, cellFor, columnIds, mintMatrixId } from '@/marketing/sections/featureMatrixModel';
import type { MatrixCell, MatrixColumn, MatrixGroup, MatrixRow } from '@/marketing/sections/featureMatrixModel';

// ── Feature matrix ────────────────────────────────────────────────────
//
// Features as rows, 2-6 licence columns, rows grouped by category. Every
// column, group and row carries a stable `id` (minted here, never shown):
// a row's cells point at their column by that id, and the server keeps a
// translation on its item through it. So columns and rows can be reordered
// freely; only the ids must never be edited by hand.

type FeatureMatrixData = SectionHeaderData & {
    columns?: MatrixColumn[];
    groups?: MatrixGroup[];
    footnote?: string;
    includedLabel?: string;
    excludedLabel?: string;
    pickerLabel?: string;
};

type Change = BlockEditorProps<FeatureMatrixData>['onChange'];

/** Edits the columns and keeps every row's cells in step with them. */
function ColumnsField({ data, onChange }: { data: FeatureMatrixData; onChange: Change }) {
    const { t } = useTranslation();
    const columns = data.columns || [];
    const setColumns = (next: MatrixColumn[]) =>
        onChange({ ...data, columns: next, groups: alignCells(data.groups || [], next) });
    // At most one column draws the eye: turning one on turns the others off.
    const setHighlight = (id: string | undefined, on: boolean) =>
        setColumns(columns.map(c => (c.id === id ? { ...c, highlight: on } : on ? { ...c, highlight: false } : c)));
    return (
        <>
            {columns.length < 2 ? (
                <InlineHint>{t('cms_site.blocks.feature_matrix.min_columns', 'Add at least two columns: with one there is nothing to compare.')}</InlineHint>
            ) : null}
            <RepeatableList
                label={t('cms_site.blocks.feature_matrix.columns', 'Columns (licences)')}
                items={columns}
                maxItems={MATRIX_COLUMNS_MAX}
                onChange={setColumns}
                makeNew={() => ({ id: mintMatrixId('col'), label: '', highlight: false })}
                itemLabel={(item) => item.label || t('cms_site.blocks.feature_matrix.no_label', '(no label)')}
                renderItem={(item, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.feature_matrix.column_label', 'Column heading')}
                            value={item.label || ''}
                            onChange={v => update({ ...item, label: v })}
                            placeholder={t('cms_site.blocks.feature_matrix.column_placeholder', 'e.g. Pro')}
                        />
                        <Toggle
                            label={t('cms_site.blocks.feature_matrix.highlight', 'Highlight this column')}
                            value={item.highlight === true}
                            onChange={v => setHighlight(item.id, v)}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.feature_matrix.add_column', 'Add column')}
            />
        </>
    );
}

/** One cell of a row: not included, included or short text. */
function CellFields({ cell, label, onChange }: { cell: MatrixCell; label: string; onChange: (next: MatrixCell) => void }) {
    const { t } = useTranslation();
    const kind = cell.kind === 'included' || cell.kind === 'text' ? cell.kind : 'excluded';
    const options = [
        { value: 'included', label: t('cms_site.blocks.feature_matrix.kind_included', 'Included (check)') },
        { value: 'excluded', label: t('cms_site.blocks.feature_matrix.kind_excluded', 'Not included (dash)') },
        { value: 'text', label: t('cms_site.blocks.feature_matrix.kind_text', 'Short text') },
    ];
    return (
        <>
            <FieldSelect label={label} value={kind} options={options} onChange={v => onChange({ ...cell, kind: v })} />
            {kind === 'text' ? (
                <TextField
                    label={t('cms_site.blocks.feature_matrix.cell_text', 'Text in {column}', { column: label })}
                    value={cell.text || ''}
                    onChange={v => onChange({ ...cell, text: v })}
                    placeholder={t('cms_site.blocks.feature_matrix.cell_placeholder', 'e.g. Up to 5')}
                />
            ) : null}
        </>
    );
}

function RowFields({ row, columns, update }: { row: MatrixRow; columns: MatrixColumn[]; update: (next: MatrixRow) => void }) {
    const { t } = useTranslation();
    const setCell = (id: string, next: MatrixCell) =>
        update({ ...row, cells: columnIds(columns).map(cid => (cid === id ? next : (cellFor(row, cid)?.cell ?? blankCell(cid)))) });
    return (
        <>
            <TextField
                label={t('cms_site.blocks.feature_matrix.row_label', 'Feature')}
                value={row.label || ''}
                onChange={v => update({ ...row, label: v })}
                placeholder={t('cms_site.blocks.feature_matrix.row_placeholder', 'e.g. Single sign-on')}
            />
            {columns.map((col, i) => (
                <CellFields
                    key={col.id || i}
                    label={col.label || t('cms_site.blocks.feature_matrix.column_n', 'Column {n}', { n: i + 1 })}
                    cell={cellFor(row, col.id)?.cell ?? blankCell(col.id || '')}
                    onChange={next => setCell(col.id || '', next)}
                />
            ))}
        </>
    );
}

function GroupsField({ data, onChange }: { data: FeatureMatrixData; onChange: Change }) {
    const { t } = useTranslation();
    const columns = data.columns || [];
    const newRow = (): MatrixRow => ({
        id: mintMatrixId('row'), label: '', cells: columnIds(columns).map(blankCell),
    });
    return (
        <RepeatableList
            label={t('cms_site.blocks.feature_matrix.groups', 'Groups (categories)')}
            items={data.groups || []}
            onChange={v => onChange(set(data, 'groups', v))}
            makeNew={() => ({ id: mintMatrixId('grp'), title: '', rows: [newRow()] })}
            itemLabel={(item) => item.title || t('cms_site.blocks.feature_matrix.no_title', '(no name)')}
            renderItem={(group, updateGroup) => (
                <>
                    <TextField
                        label={t('cms_site.blocks.feature_matrix.group_title', 'Group name')}
                        value={group.title || ''}
                        onChange={v => updateGroup({ ...group, title: v })}
                        placeholder={t('cms_site.blocks.feature_matrix.group_placeholder', 'e.g. Security')}
                    />
                    <RepeatableList
                        label={t('cms_site.blocks.feature_matrix.rows', 'Rows')}
                        items={group.rows || []}
                        onChange={rows => updateGroup({ ...group, rows })}
                        makeNew={newRow}
                        itemLabel={(row) => row.label || t('cms_site.blocks.feature_matrix.no_row_label', '(no feature)')}
                        renderItem={(row, updateRow) => <RowFields row={row} columns={columns} update={updateRow} />}
                        addLabel={t('cms_site.blocks.feature_matrix.add_row', 'Add row')}
                    />
                </>
            )}
            addLabel={t('cms_site.blocks.feature_matrix.add_group', 'Add group')}
        />
    );
}

export function FeatureMatrixEditor({ data = {}, onChange }: BlockEditorProps<FeatureMatrixData>) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.feature_matrix.hint', 'Features as rows, licences as columns, grouped by category. Click a heading or a text cell in the preview to edit it inline; use the lists below to add, remove and reorder columns, groups and rows.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="feature-matrix" />
            <ColumnsField data={data} onChange={onChange} />
            <GroupsField data={data} onChange={onChange} />
            <TextField
                label={t('cms_site.blocks.feature_matrix.footnote', 'Footnote')}
                value={data.footnote || ''}
                onChange={v => onChange(set(data, 'footnote', v))}
                placeholder={t('cms_site.blocks.feature_matrix.footnote_placeholder', 'e.g. Features may change per release.')}
            />
            <SectionDivider label={t('cms_site.blocks.feature_matrix.words', 'Fixed words')} />
            <InlineHint>{t('cms_site.blocks.feature_matrix.words_hint', 'Read out by screen readers behind the check and the dash, and shown above the table on a phone. Translated per language.')}</InlineHint>
            <TextField
                label={t('cms_site.blocks.feature_matrix.included_label', 'Word for the check')}
                value={data.includedLabel || ''}
                onChange={v => onChange(set(data, 'includedLabel', v))}
                placeholder={t('cms_site.blocks.feature_matrix.included_placeholder', 'Included')}
            />
            <TextField
                label={t('cms_site.blocks.feature_matrix.excluded_label', 'Word for the dash')}
                value={data.excludedLabel || ''}
                onChange={v => onChange(set(data, 'excludedLabel', v))}
                placeholder={t('cms_site.blocks.feature_matrix.excluded_placeholder', 'Not included')}
            />
            <TextField
                label={t('cms_site.blocks.feature_matrix.picker_label', 'Phone: label for the plan buttons')}
                value={data.pickerLabel || ''}
                onChange={v => onChange(set(data, 'pickerLabel', v))}
                placeholder={t('cms_site.blocks.feature_matrix.picker_placeholder', 'Choose a plan')}
            />
        </>
    );
}
