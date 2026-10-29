import { useCallback, useEffect, useMemo, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import PasteImportPanel from './PasteImportPanel';
import { PAGE_SIZE, createRecord, deleteRecord, listRecords, updateRecord, type RowRecord } from './recordsApi';
import {
    AddRowButton, DraftRow, NoColumnsNote, PasteRowsButton, RowsCell, RowsEmpty, RowsLoadError, RowsLoading, RowsTableView,
    RowsToolbar, ShowMoreRows, UnsavedColumnsNote, reportCellSaveError, rowCountLabelFor, useRelationRowsLoader,
} from './RowsTabParts';
import { importableFields } from './spreadsheetPaste';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import toast from '@/components/shared/Toast';
import type { RowsField, RowsTabProps } from './RowsTab.types';

export default function RowsTab({ appId, table, tables = [], fieldsUnsaved = false }: RowsTabProps) {
    const { t } = useTranslation();
    const fields = useMemo(() => importableFields(table?.fields) as RowsField[], [table]);
    const columns = useMemo(
        () => (Array.isArray(table?.fields) ? table.fields : []).filter((f) => f && f.key),
        [table],
    );

    const [rows, setRows] = useState<RowRecord[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<{ rowId: string; key: string } | null>(null); // { rowId, key }
    const [savingId, setSavingId] = useState<string | null>(null);
    const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
    const [draftError, setDraftError] = useState<string | null>(null);
    const [savingDraft, setSavingDraft] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [pasting, setPasting] = useState(false);
    const [relationRows, setRelationRows] = useState<Record<string, RowRecord[]>>({});

    const tableId = table?.id || null;

    const load = useCallback(async () => {
        if (!appId || !tableId) return;
        setLoading(true);
        setError(null);
        try {
            const page = await listRecords(appId, tableId, { limit: PAGE_SIZE });
            setRows(page.records);
            setCursor(page.nextCursor);
        } catch (err) {
            setError((err as Error)?.message || t('studio_apps_tables.rows.load_failed', 'The rows could not be loaded.'));
        } finally {
            setLoading(false);
        }
    }, [appId, tableId, t]);

    useEffect(() => {
        setDraft(null);
        setEditing(null);
        load();
    }, [load]);

    useRelationRowsLoader(appId, fields, setRelationRows);

    const saveCell = async (row: RowRecord, field: RowsField, value: unknown) => {
        setEditing(null);
        if (row[field.key] === value) return;
        setSavingId(row.id);
        try {
            // Compare-and-set on the row we actually looked at: two people in
            // this table at once used to overwrite each other with no trace.
            const res = await updateRecord(appId, tableId as string, row.id, { [field.key]: value }, {
                expectedUpdatedAt: row.updated_at || null,
            });
            const saved = res?.record;
            setRows((cur) => cur.map((r) => (r.id === row.id ? (saved || { ...r, [field.key]: value }) : r)));
        } catch (err) {
            reportCellSaveError(err, row.id, setRows, t);
        } finally {
            setSavingId(null);
        }
    };

    const saveDraft = async () => {
        setSavingDraft(true);
        setDraftError(null);
        try {
            const res = await createRecord(appId, tableId as string, draft || {});
            if (res?.record) setRows((cur) => [...cur, res.record]);
            else await load();
            setDraft(null);
        } catch (err) {
            setDraftError((err as Error)?.message || t('studio_apps_tables.rows.add_failed', 'That row could not be added.'));
        } finally {
            setSavingDraft(false);
        }
    };

    const removeRow = async () => {
        const id = confirmDeleteId;
        setConfirmDeleteId(null);
        if (!id) return;
        try {
            await deleteRecord(appId, tableId as string, id);
            setRows((cur) => cur.filter((r) => r.id !== id));
        } catch (err) {
            toast.error((err as Error)?.message || t('studio_apps_tables.rows.delete_failed', 'That row could not be deleted.'));
        }
    };

    const loadMore = async () => {
        if (!cursor) return;
        setLoadingMore(true);
        try {
            const page = await listRecords(appId, tableId as string, { limit: PAGE_SIZE, cursor });
            setRows((cur) => [...cur, ...page.records]);
            setCursor(page.nextCursor);
        } catch (err) {
            toast.error((err as Error)?.message || t('studio_apps_tables.rows.load_more_failed', 'The next rows could not be loaded.'));
        } finally {
            setLoadingMore(false);
        }
    };

    const tableFor = (fieldRef: string) => (tables || []).find((t) => t.id === fieldRef || t.key === fieldRef) || null;

    const addButton = () => (
        <AddRowButton disabled={!!draft || columns.length === 0} onAdd={() => { setDraft({}); setDraftError(null); }} />
    );
    const pasteButton = () => <PasteRowsButton disabled={columns.length === 0} onPaste={() => setPasting(true)} />;


    if (pasting) {
        return (
            <PasteImportPanel
                table={table}
                onCreate={(values) => createRecord(appId, tableId as string, values)}
                onImported={(created) => { if (created.length) setRows((cur) => [...cur, ...created]); }}
                onClose={() => setPasting(false)}
            />
        );
    }

    if (columns.length === 0) return <NoColumnsNote />;

    const cellFor = (row: RowRecord, field: RowsField) => (
        <RowsCell
            row={row}
            field={field}
            isEditing={!!editing && editing.rowId === row.id && editing.key === field.key}
            saving={savingId === row.id}
            relationRows={field.relation?.table ? relationRows[field.relation.table] : null}
            relationTable={field.relation?.table ? tableFor(field.relation.table) : null}
            onCommit={(v) => saveCell(row, field, v)}
            onEdit={() => setEditing({ rowId: row.id, key: field.key })}
            onCancel={() => setEditing(null)}
        />
    );

    return (
        <div className="flex min-h-[22rem] flex-col gap-3">
            <RowsToolbar loading={loading} countLabel={rowCountLabelFor(t, rows.length, cursor, table?.name || table?.key)}>
                {addButton()}
                {pasteButton()}
            </RowsToolbar>

            {fieldsUnsaved ? <UnsavedColumnsNote /> : null}

            {error ? <RowsLoadError error={error} onRetry={load} /> : null}

            {loading ? (
                <RowsLoading />
            ) : rows.length === 0 && !draft && !error ? (
                <RowsEmpty>
                    {addButton()}
                    {pasteButton()}
                </RowsEmpty>
            ) : (
                <RowsTableView
                    columns={columns}
                    rows={rows}
                    cellFor={cellFor}
                    onDelete={setConfirmDeleteId}
                    draftRow={draft ? (
                        <DraftRow
                            columns={columns}
                            draft={draft}
                            savingDraft={savingDraft}
                            relationRows={relationRows}
                            tableFor={tableFor}
                            onDraftChange={(key, v) => setDraft((d) => ({ ...(d || {}), [key]: v }))}
                            onSave={saveDraft}
                            onCancel={() => { setDraft(null); setDraftError(null); }}
                        />
                    ) : null}
                />
            )}

            {draftError ? (
                <p className="text-xs text-[var(--error)]" role="alert">{draftError}</p>
            ) : null}

            {cursor && !loading ? <ShowMoreRows loadingMore={loadingMore} onMore={loadMore} /> : null}

            <ConfirmDialog
                open={!!confirmDeleteId}
                title={t('studio_apps_tables.rows.delete_title', 'Delete this row?')}
                description={t('studio_apps_tables.rows.delete_desc', 'The row is removed straight away. This can’t be undone.')}
                confirmLabel={t('studio_apps_tables.rows.delete_confirm', 'Delete row')}
                destructive
                onConfirm={removeRow}
                onCancel={() => setConfirmDeleteId(null)}
            />
        </div>
    );
}
