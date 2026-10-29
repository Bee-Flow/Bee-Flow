import { AlertTriangle, ClipboardPaste, Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import { PAGE_SIZE, listRecords, type RowRecord } from './recordsApi';
import RowCellEditor from './RowCellEditor';
import { cellText } from './rowValues';
import toast from '@/components/shared/Toast';
import { logger } from '@/utils/logger';
import type { RecordWriteError, RowsField, RowsTable } from './RowsTab.types';

/**
 * The pieces of the App Studio rows tab: the relation-choice loader, the
 * toolbar buttons, one cell, the table with its draft row, and the states
 * around it. Moved out of RowsTab.tsx verbatim.
 */

const TOOL_BUTTON = 'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--bg-tertiary)] disabled:opacity-50 border-[var(--border-default)] text-[var(--text-primary)]';

// Relation cells choose a row of the table they point at, so their choices
// are that table's rows — one capped page per target, fetched once.
export function useRelationRowsLoader(
    appId: string,
    fields: RowsField[],
    setRelationRows: Dispatch<SetStateAction<Record<string, RowRecord[]>>>,
) {
    useEffect(() => {
        const targets = [...new Set(fields.filter((f) => f.type === 'relation' && f.relation?.table).map((f) => f.relation?.table))];
        if (!appId || targets.length === 0) return undefined;
        let cancelled = false;
        (async () => {
            for (const target of targets) {
                if (!target) continue;
                let page: { records: RowRecord[] } = { records: [] };
                try { page = await listRecords(appId, target, { limit: PAGE_SIZE }); } catch (err) { logger.debug('an unreadable target just offers nothing', err); }
                if (cancelled) return;
                setRelationRows((cur) => (cur[target] ? cur : { ...cur, [target]: page.records }));
            }
        })();
        return () => { cancelled = true; };
    }, [appId, fields, setRelationRows]);
}

export function rowCountLabelFor(t: TranslateFn, count: number, cursor: string | null, tableName: string | undefined) {
    const countParams = { n: count, table: tableName };
    if (count === 1) {
        return cursor
            ? t('studio_apps_tables.rows.count_one_so_far', '{n} row so far in {table}', countParams)
            : t('studio_apps_tables.rows.count_one', '{n} row in {table}', countParams);
    }
    return cursor
        ? t('studio_apps_tables.rows.count_many_so_far', '{n} rows so far in {table}', countParams)
        : t('studio_apps_tables.rows.count_many', '{n} rows in {table}', countParams);
}

export function reportCellSaveError(
    err: unknown,
    rowId: string,
    setRows: Dispatch<SetStateAction<RowRecord[]>>,
    t: TranslateFn,
) {
    if ((err as RecordWriteError)?.code === 'record_conflict' && (err as RecordWriteError).body?.record) {
        // Show them what won rather than their lost edit, and say so.
        const current = (err as RecordWriteError).body.record;
        setRows((cur) => cur.map((r) => (r.id === rowId ? current : r)));
        toast.error(t('studio_apps_tables.rows.conflict', 'Someone else changed this row — it has been refreshed with their version.'));
    } else {
        toast.error((err as Error)?.message || t('studio_apps_tables.rows.save_failed', 'That change could not be saved.'));
    }
}

export function NoColumnsNote() {
    const { t } = useTranslation();
    return (
        <p className="py-10 text-center text-sm text-[var(--text-tertiary)]">
            {t('studio_apps_tables.rows.no_columns', 'This table has no columns yet — add a few on the Tables tab first, then come back to fill them in.')}
        </p>
    );
}

export function RowsToolbar({ loading, countLabel, children }: { loading: boolean; countLabel: string; children: ReactNode }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--text-tertiary)]">
                {loading
                    ? t('studio_apps_tables.rows.loading', 'Loading rows…')
                    : countLabel}
            </span>
            <div className="ml-auto flex items-center gap-2">
                {children}
            </div>
        </div>
    );
}

export function AddRowButton({ disabled, onAdd }: { disabled: boolean; onAdd: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" onClick={onAdd} disabled={disabled} className={TOOL_BUTTON}>
            <Plus className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
            {t('studio_apps_tables.rows.add_row', 'Add a row')}
        </button>
    );
}

export function PasteRowsButton({ disabled, onPaste }: { disabled: boolean; onPaste: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" onClick={onPaste} disabled={disabled} className={TOOL_BUTTON}>
            <ClipboardPaste className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
            {t('studio_apps_tables.rows.paste', 'Paste from a spreadsheet')}
        </button>
    );
}

export interface RowsCellProps {
    row: RowRecord;
    field: RowsField;
    isEditing: boolean;
    saving: boolean;
    relationRows: RowRecord[] | null;
    relationTable: RowsTable | null;
    onCommit: (value: unknown) => void;
    onEdit: () => void;
    onCancel: () => void;
}

export function RowsCell({ row, field, isEditing, saving, relationRows, relationTable, onCommit, onEdit, onCancel }: RowsCellProps) {
    const { t } = useTranslation();
    if (field.type === 'computed') {
        return (
            <span className="text-sm text-[var(--text-tertiary)]" title={t('studio_apps_tables.rows.computed_title', 'Worked out automatically')}>
                {cellText(row[field.key], field, t)}
            </span>
        );
    }
    if (field.type === 'bool') {
        return (
            <RowCellEditor
                field={field}
                value={row[field.key] as string | number | null | undefined}
                disabled={saving}
                onCommit={onCommit}
            />
        );
    }
    if (isEditing) {
        return (
            <RowCellEditor
                field={field}
                value={row[field.key] as string | number | null | undefined}
                autoFocus
                disabled={saving}
                relationRows={relationRows}
                relationTable={relationTable}
                onCommit={onCommit}
                onCancel={onCancel}
            />
        );
    }
    return (
        <button
            type="button"
            onClick={onEdit}
            className="w-full truncate rounded-md px-1 py-1 text-left text-sm hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
            aria-label={t('studio_apps_tables.rows.click_to_change', '{name} — click to change', { name: field.name || field.key })}
        >
            {cellText(row[field.key], field, t)}
        </button>
    );
}

export function UnsavedColumnsNote() {
    const { t } = useTranslation();
    return (
        <p
            className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs [border-color:rgba(217,119,6,0.4)] [background:rgba(217,119,6,0.1)] [color:#d97706]!"
        >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t('studio_apps_tables.rows.unsaved_columns', 'You changed the columns but haven’t saved yet — these rows still show the saved ones. Save the table to see the change here.')}</span>
        </p>
    );
}

export function RowsLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs border-[var(--border-default)] text-[var(--text-secondary)]">
            <span>{error}</span>
            <button
                type="button"
                onClick={onRetry}
                className="rounded-md border px-2 py-0.5 border-[var(--border-default)] text-[var(--text-primary)]"
            >
                {t('studio_apps_tables.rows.try_again', 'Try again')}
            </button>
        </div>
    );
}

export function RowsLoading() {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--text-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('studio_apps_tables.rows.loading', 'Loading rows…')}
        </div>
    );
}

export function RowsEmpty({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-10 text-center border-[var(--border-default)]">
            <p className="text-sm font-medium text-[var(--text-primary)]">{t('studio_apps_tables.rows.empty', 'No rows yet.')}</p>
            <p className="max-w-sm text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_tables.rows.empty_hint', 'Type the first one here, or paste a block straight out of Excel or Google Sheets — you pick which column goes where.')}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
                {children}
            </div>
        </div>
    );
}

export interface DraftRowProps {
    columns: RowsField[];
    draft: Record<string, unknown>;
    savingDraft: boolean;
    relationRows: Record<string, RowRecord[]>;
    tableFor: (fieldRef: string) => RowsTable | null;
    onDraftChange: (key: string, value: unknown) => void;
    onSave: () => void;
    onCancel: () => void;
}

export function DraftRow({ columns, draft, savingDraft, relationRows, tableFor, onDraftChange, onSave, onCancel }: DraftRowProps) {
    const { t } = useTranslation();
    return (
        <tr>
            {columns.map((f) => (
                <td key={f.key} className="border-b px-2 py-1 align-top border-[var(--border-default)]">
                    {f.type === 'computed' ? (
                        <span className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_tables.rows.computed_later', 'Worked out later')}</span>
                    ) : (
                        <RowCellEditor
                            field={f}
                            value={(draft[f.key] ?? null) as string | number | null}
                            live
                            disabled={savingDraft}
                            relationRows={f.relation?.table ? relationRows[f.relation.table] : null}
                            relationTable={f.relation?.table ? tableFor(f.relation.table) : null}
                            onCommit={(v) => onDraftChange(f.key, v)}
                        />
                    )}
                </td>
            ))}
            <td className="border-b px-2 py-1 align-middle border-[var(--border-default)]">
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={savingDraft}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-white disabled:opacity-50 bg-[var(--accent-primary)]"
                    >
                        {savingDraft ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                        {t('studio_apps_tables.rows.add', 'Add')}
                    </button>
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={savingDraft}
                        className="rounded-md border px-2 py-1 text-xs disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        {t('studio_apps_tables.rows.cancel', 'Cancel')}
                    </button>
                </div>
            </td>
        </tr>
    );
}

export interface RowsTableViewProps {
    columns: RowsField[];
    rows: RowRecord[];
    cellFor: (row: RowRecord, field: RowsField) => ReactNode;
    onDelete: (rowId: string) => void;
    draftRow: ReactNode;
}

export function RowsTableView({ columns, rows, cellFor, onDelete, draftRow }: RowsTableViewProps) {
    const { t } = useTranslation();
    return (
        <div className="w-full overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr>
                        {columns.map((f) => (
                            <th
                                key={f.key}
                                scope="col"
                                className="border-b px-2 py-1.5 text-left text-xs font-medium border-[var(--border-default)] text-[var(--text-secondary)]"
                            >
                                {f.name || f.key}
                                {f.required ? <span aria-hidden="true" className="text-[var(--error)]"> *</span> : null}
                            </th>
                        ))}
                        <th className="border-b px-2 py-1.5 border-[var(--border-default)]" aria-label={t('studio_apps_tables.rows.row_actions', 'Row actions')} />
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, index) => (
                        <tr key={row.id}>
                            {columns.map((f) => (
                                <td key={f.key} className="border-b px-2 py-1 align-top border-[var(--border-default)]">
                                    {cellFor(row, f)}
                                </td>
                            ))}
                            <td className="border-b px-2 py-1 align-middle border-[var(--border-default)]">
                                <button
                                    type="button"
                                    aria-label={t('studio_apps_tables.rows.delete_row_n', 'Delete row {n}', { n: index + 1 })}
                                    onClick={() => onDelete(row.id)}
                                    className="rounded p-1 hover:bg-[var(--bg-card-hover)] text-[var(--error)]"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </td>
                        </tr>
                    ))}
                    {draftRow}
                </tbody>
            </table>
        </div>
    );
}

export function ShowMoreRows({ loadingMore, onMore }: { loadingMore: boolean; onMore: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onMore}
            disabled={loadingMore}
            className="self-center inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
        >
            {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {t('studio_apps_tables.rows.show_more', 'Show more rows')}
        </button>
    );
}
