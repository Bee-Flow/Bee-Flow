/**
 * The write side of RowBrowser: add, edit, delete one, delete the ticked
 * ones, import and export. Every write re-reads the page and tells the
 * caller (`onChanged` refreshes the table row in the list, which carries
 * `rowCount` — the number the destructive-column dialog prices an
 * irreversible decision on).
 */
import { useState } from 'react';
import { BULK_DELETE_MAX, messageOf, rowsApi } from './rowBrowserModel';
import type { ApiError, DtRow, DtTable } from './rowBrowserModel';
import { sourceErrorMessage } from './typedViews';
import type { RowPages } from './useRowPages';
import type { TranslateFn } from '../../../../../hooks/useTranslation';

interface RowWriteInputs {
    table: DtTable;
    t: TranslateFn;
    pages: RowPages;
    isMirror: boolean;
    onChanged?: (() => void) | null;
}

export function useRowWrites({ table, t, pages, isMirror, onChanged }: RowWriteInputs) {
    const { load, setError, setBusy, selected } = pages;
    const [adding, setAdding] = useState(false);
    const [importing, setImporting] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);      // rowId
    const [draft, setDraft] = useState<Record<string, unknown>>({});
    const [pendingDelete, setPendingDelete] = useState<DtRow | null>(null);
    const [pendingBulk, setPendingBulk] = useState(false);
    const [writing, setWriting] = useState(false);
    const sourceError = (e: unknown, fallback: string) => sourceErrorMessage(t, e, table) || messageOf(e, fallback);
    const stopEditing = () => { setEditing(null); setDraft({}); };

    const afterWrite = async (body: { renumbered?: boolean } | null = null) => {
        await load();
        onChanged?.();
        // A write that RENUMBERED the rows (a row-number-keyed sheet after a
        // delete or a mid-sheet insert) moved every id below it. The page just
        // loaded already shows the new ids; a row still in edit would be
        // holding an id that now names its neighbour, so it is closed.
        if (body && body.renumbered === true) stopEditing();
    };

    const removeRow = async (row: DtRow) => {
        setWriting(isMirror);
        try {
            const body = await rowsApi.deleteRow(table.id, row.id);
            setPendingDelete(null);
            await afterWrite(body);
        } catch (e) {
            setPendingDelete(null);
            setError(sourceError(e, t('datatables.err_row_delete', 'Could not delete the row')));
        } finally {
            setWriting(false);
        }
    };

    /**
     * Everything ticked, in ONE request and ONE transaction.
     *
     * The answer's `deleted` is what Postgres actually removed after the
     * access predicate, which can be fewer than were asked for — a row a
     * colleague deleted a second ago, or one this account may not see. Say the
     * real number rather than the requested one; claiming a delete that did
     * not happen is worse than a smaller number.
     */
    const removeSelected = async () => {
        const ids = [...selected];
        setPendingBulk(false);
        if (!ids.length) return;
        setBusy(true);
        try {
            const body = await rowsApi.bulkDeleteRows(table.id, ids);
            const deleted = Number(body?.deleted) || 0;
            // The refresh FIRST, the message after: load() clears the error as
            // it starts, so setting it before reloading wipes the very
            // sentence that explains what just happened.
            await afterWrite();
            if (deleted < ids.length) {
                setError(t('datatables.bulk_partial', 'Deleted {n} of {asked} rows — the rest were already gone.', { n: deleted, asked: ids.length }));
            }
        } catch (e) {
            setBusy(false);
            const err = e as ApiError;
            setError(err.code === 'too_many_ids'
                ? t('datatables.bulk_too_many', 'You can delete at most {limit} rows at a time.', { limit: err.body?.limit ?? BULK_DELETE_MAX })
                : messageOf(e, t('datatables.err_bulk_delete', 'Could not delete those rows')));
        }
    };

    const saveEdit = async (row: DtRow) => {
        setWriting(isMirror);
        try {
            // The updated_at the row was READ with. Without it two colleagues
            // with this tab open silently overwrite each other; with it, the
            // second save comes back 409 and says so.
            const body = await rowsApi.updateRow(table.id, row.id, draft, row.updated_at);
            stopEditing();
            await afterWrite(body);
        } catch (e) {
            const conflict = (e as ApiError).code === 'row_conflict';
            // The refresh FIRST, the message after: load() clears the error as
            // it starts, so setting the message before reloading wipes the very
            // sentence that explains what just happened.
            if (conflict) { stopEditing(); await load(); }
            // A source's refusal keeps the row IN EDIT with the draft: the
            // person fixes the value and saves again; nothing changed anywhere.
            // A `spreadsheet_conflict` (the file moved under the write) too —
            // the draft is the person's work, and the rows reload by
            // themselves when the pulse sees the version move.
            setError(conflict
                ? t('datatables.err_row_conflict', 'Someone else changed this row while you had it open — the list has been refreshed.')
                : sourceError(e, t('datatables.err_row_save', 'Could not save the row')));
        } finally {
            setWriting(false);
        }
    };

    const addRow = async (values: Record<string, unknown>) => {
        setWriting(isMirror);
        try {
            const body = await rowsApi.addRow(table.id, values);
            setAdding(false);
            await afterWrite(body);
        } catch (e) {
            setError(sourceError(e, t('datatables.err_row_add', 'Could not add the row')));
        } finally {
            setWriting(false);
        }
    };

    const exportCsv = async () => {
        try {
            const text = await rowsApi.exportCsv(table.id);
            // A Blob and a revoked object URL, NEVER an <a href download>
            // pointing at the API: that link carries no auth header, and on
            // this stack a same-origin download navigates the SPA away from
            // itself (the automations library learned it the hard way).
            const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${table.key || 'datatable'}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(messageOf(e, t('datatables.err_export', 'Could not export the rows')));
        }
    };

    return {
        adding, setAdding, importing, setImporting, editing, setEditing, draft, setDraft, stopEditing,
        pendingDelete, setPendingDelete, pendingBulk, setPendingBulk, writing,
        afterWrite, removeRow, removeSelected, saveEdit, addRow, exportCsv,
    };
}

export type RowWrites = ReturnType<typeof useRowWrites>;
