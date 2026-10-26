import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { ExpiryCell, HeadCell, ManagedCell, RelationCell } from './RowCells';
import { ICON_BTN } from './rowBrowserModel';
import type { DtColumn, DtMirror, DtRow, DtTable } from './rowBrowserModel';
import { RowCellEditor } from './typedViews';
import type { RowPages } from './useRowPages';
import type { RowWrites } from './useRowWrites';
import useRelativeTime from '@/hooks/useRelativeTime';
import useTranslation from '@/hooks/useTranslation';
// App Studio's formatter, not the local one: it takes the FIELD rather than a
// type string, so it can render a select's label and a multiselect's list.
import { cellText } from '../../AppStudio/tables/rowValues';
import { columnKeyTitle, columnLabel, columnTypeKind } from '../datatableDisplay';

type Retention = { retentionDays: number; retentionField: string } | null;

interface RowsTableProps {
    pages: RowPages;
    writes: RowWrites;
    table: DtTable;
    mirror: DtMirror | null;
    canWrite: boolean;
    fullPage: boolean;
    retention: Retention;
}

const ACTION_STYLE = { color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' };

/** Save/stop while a row is in edit; edit/delete otherwise. */
function RowActions({ row, writes }: { row: DtRow; writes: RowWrites }) {
    const { t } = useTranslation();
    const { editing, saveEdit, stopEditing, setEditing, setDraft, setPendingDelete } = writes;
    if (editing === row.id) {
        return (
            <>
                <button type="button" onClick={() => saveEdit(row)}
                    aria-label={t('datatables.row_save', 'Save this row')} className={ICON_BTN}
                    style={{ color: 'var(--accent-primary)', outlineColor: 'var(--accent-primary)' }}>
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button type="button" onClick={stopEditing}
                    aria-label={t('datatables.row_stop_edit', 'Stop editing this row')} className={ICON_BTN}
                    style={ACTION_STYLE}>
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </>
        );
    }
    return (
        <>
            <button type="button" onClick={() => { setEditing(row.id); setDraft({}); }}
                aria-label={t('datatables.row_edit', 'Edit this row')} className={ICON_BTN}
                style={ACTION_STYLE}>
                <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setPendingDelete(row)}
                aria-label={t('datatables.row_delete', 'Delete this row')} className={ICON_BTN}
                style={ACTION_STYLE}>
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
        </>
    );
}

interface RowLineProps {
    row: DtRow;
    columns: DtColumn[];
    pages: RowPages;
    writes: RowWrites;
    table: DtTable;
    mirror: DtMirror | null;
    canWrite: boolean;
    retention: Retention;
}

function RowLine({ row: r, columns, pages, writes, table, mirror, canWrite, retention }: RowLineProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const { selected, setSelected } = pages;
    const { editing, draft, setDraft } = writes;
    const isEditing = editing === r.id;
    const toggleRow = (id: string) => setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    return (
        <tr className="[border-top:1px_solid_var(--border-default)]">
            {canWrite && (
                <td className="px-3 py-2.5 align-top">
                    <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleRow(r.id)}
                        aria-label={t('datatables.select_row', 'Select this row')}
                    />
                </td>
            )}
            {columns.map(c => (
                <td key={c.key} className={`px-3 py-2.5 align-top ${isEditing ? '' : 'max-w-[16rem] truncate'} ${columnTypeKind(c.type) === 'number' ? 'text-right tabular-nums' : ''} text-[var(--text-primary)]`}
                    title={isEditing ? undefined : cellText(r[c.key], c)}>
                    {isEditing && !c.derived && c.type !== 'relation' ? (
                        <RowCellEditor
                            field={c}
                            value={draft[c.key] !== undefined ? draft[c.key] : r[c.key]}
                            live
                            onCommit={(v: unknown) => setDraft(d => ({ ...d, [c.key]: v }))}
                        />
                    ) : c.type === 'relation'
                        ? <RelationCell t={t} column={c} row={r} columns={columns} mirror={mirror} />
                        : <ManagedCell t={t} managedKind={table.managedKind} column={c} row={r} />}
                </td>
            ))}
            <td className="px-3 py-2.5 align-top whitespace-nowrap text-[var(--text-tertiary)]"
                title={r.created_at ? String(r.created_at).slice(0, 16).replace('T', ' ') : undefined}>
                {r.created_at ? rel(r.created_at) : '—'}
            </td>
            {retention && (
                <td className="px-3 py-2.5 align-top whitespace-nowrap">
                    <ExpiryCell t={t} row={r} retention={retention} />
                </td>
            )}
            {canWrite && (
                <td className="px-2 py-2.5 align-top whitespace-nowrap">
                    <RowActions row={r} writes={writes} />
                </td>
            )}
        </tr>
    );
}

/**
 * The rows. The table scrolls INSIDE its own box: a wide datatable must never
 * make the whole Studio page scroll sideways. On the page layout the box is
 * the whole main area (2b).
 */
export default function RowsTable({ pages, writes, table, mirror, canWrite, fullPage, retention }: RowsTableProps) {
    const { t } = useTranslation();
    const { rows, columns, selected, setSelected, sort, toggleSort } = pages;
    const shown = rows || [];
    const allShownSelected = !!shown.length && shown.every(r => selected.has(r.id));
    const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set(shown.map(r => r.id)));
    return (
        <div className={fullPage ? 'flex-1 min-h-0 overflow-auto' : 'overflow-x-auto'} style={fullPage ? {
            background: 'var(--bg-card)', borderTop: '1px solid var(--border-default)',
        } : {
            borderRadius: 12, background: 'var(--bg-card)',
            border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)',
        }}>
            <table className="w-full text-xs">
                <thead>
                    <tr className="bg-[var(--bg-secondary)]">
                        {canWrite && (
                            <th className="px-3 py-2.5 w-10">
                                <input
                                    type="checkbox"
                                    checked={allShownSelected}
                                    onChange={toggleAll}
                                    aria-label={t('datatables.select_all', 'Select every row on this page')}
                                />
                            </th>
                        )}
                        {columns.map(c => (
                            <HeadCell key={c.key} t={t} sort={sort} field={c.key} onSort={() => toggleSort(c.key)}
                                label={columnLabel(c)} title={columnKeyTitle(c)}
                                kind={columnTypeKind(c.type)} numeric={columnTypeKind(c.type) === 'number'} />
                        ))}
                        <HeadCell t={t} sort={sort} field="created_at" onSort={() => toggleSort('created_at')}
                            label={t('datatables.col_added', 'Added')} kind="date" muted />
                        {retention && (
                            <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap text-[var(--text-secondary)]">
                                {t('datatables.col_expires', 'Expires')}
                            </th>
                        )}
                        {canWrite && <th className="px-2 py-2.5"><span className="sr-only">{t('datatables.row_actions', 'Actions')}</span></th>}
                    </tr>
                </thead>
                <tbody>
                    {shown.map(r => (
                        <RowLine key={r.id} row={r} columns={columns} pages={pages} writes={writes} table={table}
                            mirror={mirror} canWrite={canWrite} retention={retention} />
                    ))}
                </tbody>
            </table>
            {fullPage && canWrite && !writes.adding && (
                <button type="button" onClick={() => { writes.setAdding(true); writes.setImporting(false); }}
                    className="w-full text-left text-xs font-medium inline-flex items-center gap-1.5 px-4 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!" data-testid="rows-add-ghost">
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.add_row', 'Add a row')}
                </button>
            )}
        </div>
    );
}
