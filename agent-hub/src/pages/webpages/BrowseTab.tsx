import { Table2, RefreshCw, Plus, Trash2, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import type { BrowseTabProps, DbColumn, DbRow, DbTable, EditState } from './WebpageDbViewer.types';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { nOf } from '../../components/admin/Studio/KnowledgeStudio/plural';
import useConfirm from '../../components/shared/useConfirm';
import useTranslation, { TranslateParams } from '../../hooks/useTranslation';
import { webpageRequest as api } from '../../api/webpagesRequest';
import { errorMessage } from '../../utils/caughtError';

const PAGE_SIZE = 50;

export function quoteIdent(name: unknown): string {
    // SQLite identifier — double-quotes; embedded quotes become two double-quotes.
    return `"${String(name).replace(/"/g, '""')}"`;
}

export function formatCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

export function BrowseTab({ webpageId, schema, onError }: BrowseTabProps) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    // t via a ref in the loader: without a TranslationProvider, t is a new function
    // on every render, and in the deps of load() that would fire the load effect
    // endlessly.
    const tRef = useRef(t);
    tRef.current = t;
    const tables = useMemo(() => schema?.tables || [], [schema?.tables]);
    const [tableName, setTableName] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [rows, setRows] = useState<DbRow[]>([]);
    const [columns, setColumns] = useState<string[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [editing, setEditing] = useState<EditState | null>(null); // { rowidx, col, value }
    const [inserting, setInserting] = useState(false);
    const [insertValues, setInsertValues] = useState<Record<string, string>>({});

    useEffect(() => {
        if (!tableName && tables.length) setTableName(tables[0].name);
    }, [tables, tableName]);

    const tableMeta = tables.find((tbl: DbTable) => tbl.name === tableName);

    const load = useCallback(async () => {
        if (!tableName) return;
        setLoading(true);
        try {
            const offset = page * PAGE_SIZE;
            const sql = `SELECT rowid, * FROM ${quoteIdent(tableName)} LIMIT ? OFFSET ?`;
            const r = await api(webpageId, '/db/query', { method: 'POST', body: JSON.stringify({ sql, params: [PAGE_SIZE, offset] }) });
            const data = await r.json();
            if (!r.ok) { onError(data.error || tRef.current('webpages.db.err_query', 'Query failed')); setRows([]); setColumns([]); setLoading(false); return; }
            setRows(data.rows || []);
            setColumns(data.columns || []);

            const cnt = await api(webpageId, '/db/query', { method: 'POST', body: JSON.stringify({ sql: `SELECT COUNT(*) AS n FROM ${quoteIdent(tableName)}` }) });
            const cdata = await cnt.json();
            if (cnt.ok) {
                setTotal(cdata.rows?.[0]?.n ?? 0);
            } else {
                // Pagination math runs against `total`; if the count query
                // fails, surface it instead of leaving the controls anchored
                // to a stale value from a previous table. Fall back to the
                // current page size as a best-effort lower bound.
                console.warn('[WebpageDbViewer] COUNT(*) failed:', cdata?.error);
                onError(cdata?.error || tRef.current('webpages.db.err_count', 'Row count unavailable — pagination may be incorrect'));
                setTotal((data.rows || []).length);
            }
        } catch (e) {
            onError(errorMessage(e));
        } finally {
            setLoading(false);
        }
    }, [webpageId, tableName, page, onError]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { setPage(0); }, [tableName]);

    const dataColumns = columns.filter((c: string) => c !== 'rowid');

    const startEdit = (rowidx: number, col: string, value: unknown) => {
        // Don't allow editing rowid itself.
        if (col === 'rowid') return;
        setEditing({ rowidx, col, value: value === null ? '' : formatCell(value), wasNull: value === null });
    };

    const commitEdit = async () => {
        if (!editing) return;
        const { rowidx, col, value, wasNull } = editing;
        const row = rows[rowidx];
        if (!row || row.rowid === undefined) {
            setEditing(null);
            return;
        }
        // Treat empty string as either '' (TEXT) or NULL: if originally NULL and unchanged, no-op.
        const newVal = value;
        if (wasNull && newVal === '') { setEditing(null); return; }
        try {
            const sql = `UPDATE ${quoteIdent(tableName)} SET ${quoteIdent(col)} = ? WHERE rowid = ?`;
            const r = await api(webpageId, '/db/exec', { method: 'POST', body: JSON.stringify({ sql, params: [newVal, row.rowid] }) });
            const data = await r.json();
            if (!r.ok) { onError(data.error || t('webpages.db.err_update', 'Update failed')); return; }
            setEditing(null);
            await load();
        } catch (e) {
            onError(errorMessage(e));
        }
    };

    const deleteRow = async (rowidx: number) => {
        const row = rows[rowidx];
        if (!row || row.rowid === undefined) return;
        if (!(await confirm({ title: t('webpages.db.confirm_delete_row', 'Delete row rowid={rowid}?', { rowid: row.rowid }), confirmLabel: t('common.delete', 'Delete'), destructive: true }))) return;
        try {
            const sql = `DELETE FROM ${quoteIdent(tableName)} WHERE rowid = ?`;
            const r = await api(webpageId, '/db/exec', { method: 'POST', body: JSON.stringify({ sql, params: [row.rowid] }) });
            const data = await r.json();
            if (!r.ok) { onError(data.error || t('webpages.db.err_delete', 'Delete failed')); return; }
            await load();
        } catch (e) {
            onError(errorMessage(e));
        }
    };

    const handleInsert = async () => {
        if (!tableMeta) return;
        const cols = tableMeta.columns;
        const values = cols.map((c: DbColumn) => insertValues[c.name]);
        const colNames = cols.map((c: DbColumn) => quoteIdent(c.name)).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const sql = `INSERT INTO ${quoteIdent(tableName)} (${colNames}) VALUES (${placeholders})`;
        // Convert blank strings on integer/real columns to null so the user gets default behaviour.
        const params = cols.map((c: DbColumn, i: number) => {
            const v = values[i];
            if (v === undefined || v === '') return null;
            if (/^(INT|REAL|NUM)/i.test(c.type || '')) { // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an anchored alternation of literals: linear
                const n = Number(v);
                return Number.isFinite(n) ? n : v;
            }
            return v;
        });
        try {
            const r = await api(webpageId, '/db/exec', { method: 'POST', body: JSON.stringify({ sql, params }) });
            const data = await r.json();
            if (!r.ok) { onError(data.error || t('webpages.db.err_insert', 'Insert failed')); return; }
            setInserting(false);
            setInsertValues({});
            await load();
        } catch (e) {
            onError(errorMessage(e));
        }
    };

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <div className="flex flex-col h-full text-[var(--vsc-fg)]">
            <BrowseTabSection2 tableName={tableName} setTableName={setTableName} tables={tables} t={t} load={load} total={total} setPage={setPage} page={page} totalPages={totalPages} setInserting={setInserting} setInsertValues={setInsertValues} tableMeta={tableMeta} />

            {inserting && tableMeta && (
                <div className="shrink-0 border-b p-3 border-[var(--vsc-border)] bg-[var(--vsc-sidebar-bg)]">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--vsc-fg-muted)]">{t('webpages.db.new_row', 'New row')}</span>
                        <button onClick={() => setInserting(false)} className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]"><X size={12} /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-2">
                        {tableMeta.columns.map((c: DbColumn) => (
                            <div key={c.name} className="flex flex-col">
                                <label className="text-[10px] mb-0.5 text-[var(--vsc-fg-muted)]">
                                    {c.name} <span className="font-mono">{c.type}</span>{c.primaryKey ? ` · ${t('webpages.db.pk', 'PK')}` : ''}{c.notNull ? ` · ${t('webpages.db.not_null', 'NOT NULL')}` : ''}
                                </label>
                                <input
                                    value={insertValues[c.name] ?? ''}
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInsertValues((v: Record<string, string>) => ({ ...v, [c.name]: e.target.value }))}
                                    placeholder={c.defaultValue ?? (c.notNull ? t('webpages.db.required', 'required') : 'NULL')}
                                    className="px-2 py-1 text-[12px] rounded border outline-none [border-color:var(--vsc-border)] [background:var(--vsc-editor-bg)] [color:var(--vsc-fg)]!"
                                />
                            </div>
                        ))}
                    </div>
                    <button
                        onClick={handleInsert}
                        className="px-3 py-1 rounded text-[12px] font-medium [background:var(--vsc-accent)] [color:#fff]!"
                    >
                        {t('webpages.db.insert', 'Insert')}
                    </button>
                </div>
            )}

            <BrowseTabSection loading={loading} tableName={tableName} t={t} rows={rows} dataColumns={dataColumns} editing={editing} startEdit={startEdit} setEditing={setEditing} commitEdit={commitEdit} deleteRow={deleteRow} />
            {confirmDialog}
        </div>
    );
}

function BrowseTabSection2({ tableName, setTableName, tables, t, load, total, setPage, page, totalPages, setInserting, setInsertValues, tableMeta }: { tableName: string | null; setTableName: React.Dispatch<React.SetStateAction<string | null>>; tables: DbTable[]; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; load: () => Promise<void>; total: number; setPage: React.Dispatch<React.SetStateAction<number>>; page: number; totalPages: number; setInserting: React.Dispatch<React.SetStateAction<boolean>>; setInsertValues: React.Dispatch<React.SetStateAction<Record<string, string>>>; tableMeta: DbTable | undefined; }) {
    return <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0 border-[var(--vsc-border)]">
        <Table2 size={14} className="[color:var(--vsc-fg-muted)]" />
        <select
            value={tableName || ''}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTableName(e.target.value)}
            className="px-2 py-1 text-[12px] rounded border outline-none [border-color:var(--vsc-border)] [background:var(--vsc-editor-bg)] [color:var(--vsc-fg)]!"
        >
            {tables.length === 0 && <option value="">{t('webpages.db.no_tables_option', '— no tables —')}</option>}
            {tables.map((tbl: DbTable) => <option key={tbl.name} value={tbl.name}>{tbl.name}</option>)}
        </select>
        <button onClick={load} className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]" title={t('webpages.refresh', 'Refresh')}>
            <RefreshCw size={13} />
        </button>
        <div className="flex-1" />
        <span className="text-[11px] text-[var(--vsc-fg-muted)]">
            {nOf(t, 'webpages.db.rows', total, '{count} row', '{count} rows')}
        </span>
        <button
            onClick={() => setPage((p: number) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="p-1 rounded hover:bg-[var(--vsc-hover-bg)] disabled:opacity-40"
            title={t('webpages.db.prev_page', 'Previous page')}
        >
            <ChevronLeft size={14} />
        </button>
        <span className="text-[11px] text-[var(--vsc-fg-muted)]">
            {page + 1} / {totalPages}
        </span>
        <button
            onClick={() => setPage((p: number) => p + 1 < totalPages ? p + 1 : p)}
            disabled={page + 1 >= totalPages}
            className="p-1 rounded hover:bg-[var(--vsc-hover-bg)] disabled:opacity-40"
            title={t('webpages.db.next_page', 'Next page')}
        >
            <ChevronRight size={14} />
        </button>
        <button
            onClick={() => { setInserting(true); setInsertValues({}); } }
            disabled={!tableMeta}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] disabled:opacity-50 [background:var(--vsc-accent)] [color:#fff]!"
        >
            <Plus size={12} /> {t('webpages.db.insert_row', 'Insert row')}
        </button>
    </div>;
}

function BrowseTabSection({ loading, tableName, t, rows, dataColumns, editing, startEdit, setEditing, commitEdit, deleteRow }: { loading: boolean; tableName: string | null; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; rows: DbRow[]; dataColumns: string[]; editing: EditState | null; startEdit: (rowidx: number, col: string, value: unknown) => void; setEditing: React.Dispatch<React.SetStateAction<EditState | null>>; commitEdit: () => Promise<void>; deleteRow: (rowidx: number) => Promise<void>; }) {
    return <div className="flex-1 overflow-auto">
        {loading ? (
            <div className="flex items-center justify-center py-8"><Loader2 size={16} className="animate-spin" /></div>
        ) : !tableName ? (
            <div className="px-3 py-8 text-[12px] text-[var(--vsc-fg-muted)]">{t('webpages.db.no_table_selected', 'No table selected.')}</div>
        ) : rows.length === 0 ? (
            <div className="px-3 py-8 text-[12px] text-[var(--vsc-fg-muted)]">{t('webpages.db.empty_table', 'Empty table.')}</div>
        ) : (
            <table className="w-full text-[12px] [border-collapse:collapse] [table-layout:auto]">
                <thead className="[position:sticky] [top:0] [background:var(--vsc-sidebar-bg)]">
                    <tr className="[border-bottom:1px_solid_var(--vsc-border)]">
                        <th className="text-left px-2 py-1.5 font-mono text-[var(--vsc-fg-muted)]">rowid</th>
                        {dataColumns.map((c: string) => (
                            <th key={c} className="text-left px-2 py-1.5 font-mono text-[var(--vsc-fg-muted)]">{c}</th>
                        ))}
                        <th className="w-[32px]"></th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row: DbRow, rowidx: number) => (
                        <tr key={row.rowid ?? rowidx} className="hover:bg-[var(--vsc-hover-bg)] [border-bottom:1px_solid_var(--vsc-border)]">
                            <td className="px-2 py-1 font-mono text-[var(--vsc-fg-muted)]">{row.rowid}</td>
                            {dataColumns.map((c: string) => {
                                const isEditing = editing && editing.rowidx === rowidx && editing.col === c;
                                const v = row[c];
                                return (
                                    <td key={c} className="px-2 py-1 font-mono [cursor:text]" onDoubleClick={() => startEdit(rowidx, c, v)}>
                                        {isEditing ? (
                                            <input
                                                autoFocus
                                                value={editing.value}
                                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing((s: EditState | null) => ({ ...s, value: e.target.value }) as EditState)}
                                                onBlur={commitEdit}
                                                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                                                    if (e.key === 'Enter') commitEdit();
                                                    else if (e.key === 'Escape') setEditing(null);
                                                } }
                                                className="w-full px-1 py-0.5 text-[12px] rounded border outline-none [border-color:var(--vsc-accent)] [background:var(--vsc-editor-bg)] [color:var(--vsc-fg)]!" />
                                        ) : v === null || v === undefined ? (
                                            <span className="[color:var(--vsc-fg-muted)] [font-style:italic]">NULL</span>
                                        ) : (
                                            <span className="block max-w-[400px] truncate" title={formatCell(v)}>{formatCell(v)}</span>
                                        )}
                                    </td>
                                );
                            })}
                            <td className="px-1">
                                <button
                                    onClick={() => deleteRow(rowidx)}
                                    className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]"
                                    title={t('webpages.db.delete_row', 'Delete row')}
                                >
                                    <Trash2 size={12} className="[color:#ef4444]" />
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        )}
    </div>;
}
