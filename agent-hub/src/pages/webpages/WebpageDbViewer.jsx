import {
    Database, Table2, Play, RefreshCw, Plus, Trash2, AlertTriangle,
    ChevronLeft, ChevronRight, Loader2, KeyRound, X,
} from 'lucide-react';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { nOf, pluralKey } from '../../components/admin/Studio/KnowledgeStudio/plural';
import useConfirm from '../../components/shared/useConfirm';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * WebpageDbViewer — three-tab UI on top of the per-webpage SQLite DB.
 *
 *   Schema  list tables + their columns (click + new-table form)
 *   Browse  pick a table, page through rows, edit/insert/delete
 *   SQL     free-form editor; auto-routes SELECT → /db/query, else → /db/exec
 *
 * Endpoints (server/routes/webpages.js):
 *   GET    /api/webpages/:id/db/schema
 *   POST   /api/webpages/:id/db/query  { sql, params? }
 *   POST   /api/webpages/:id/db/exec   { sql, params? }
 *   DELETE /api/webpages/:id/db
 */

const PAGE_SIZE = 50;

function quoteIdent(name) {
    // SQLite identifier — double-quotes; embedded quotes become two double-quotes.
    return `"${String(name).replace(/"/g, '""')}"`;
}

function formatCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

function api(webpageId, path, opts = {}) {
    const url = `${API_BASE}/api/webpages/${webpageId}${path}`;
    const headers = opts.body ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers;
    return authFetch(url, { ...opts, headers });
}

// ─── Schema tab ─────────────────────────────────────────────────────

function SchemaTab({ webpageId, schema, onRefresh, busy, onError, unreadable = false }) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [cols, setCols] = useState([{ name: 'id', type: 'INTEGER', pk: true, notnull: true }]);
    const [submitting, setSubmitting] = useState(false);
    const [selected, setSelected] = useState(null);

    useEffect(() => {
        if (!selected && schema?.tables?.length) setSelected(schema.tables[0].name);
    }, [schema, selected]);

    const addCol = () => setCols(cs => [...cs, { name: '', type: 'TEXT', pk: false, notnull: false }]);
    const updateCol = (i, patch) => setCols(cs => cs.map((c, idx) => idx === i ? { ...c, ...patch } : c));
    const removeCol = (i) => setCols(cs => cs.filter((_, idx) => idx !== i));

    const handleCreate = async () => {
        if (!name.trim()) return;
        const validCols = cols.filter(c => c.name.trim());
        if (validCols.length === 0) { onError(t('webpages.db.err_no_columns', 'Add at least one column')); return; }
        const colSql = validCols.map(c => {
            let s = `${quoteIdent(c.name.trim())} ${c.type || 'TEXT'}`;
            if (c.pk) s += ' PRIMARY KEY';
            if (c.notnull && !c.pk) s += ' NOT NULL';
            return s;
        }).join(', ');
        const sql = `CREATE TABLE ${quoteIdent(name.trim())} (${colSql});`;
        setSubmitting(true);
        try {
            const r = await api(webpageId, '/db/exec', { method: 'POST', body: JSON.stringify({ sql }) });
            if (!r.ok) { onError((await r.json().catch(() => ({}))).error || t('webpages.db.err_create', 'Failed to create table')); return; }
            setCreating(false);
            setName('');
            setCols([{ name: 'id', type: 'INTEGER', pk: true, notnull: true }]);
            onRefresh();
        } catch (e) {
            onError(e.message);
        } finally {
            setSubmitting(false);
        }
    };

    const handleDropTable = async (tname) => {
        if (!(await confirm({ title: t('webpages.db.confirm_drop', 'Drop table "{name}"? This cannot be undone.', { name: tname }), confirmLabel: t('common.delete', 'Delete'), destructive: true }))) return;
        try {
            const r = await api(webpageId, '/db/exec', { method: 'POST', body: JSON.stringify({ sql: `DROP TABLE ${quoteIdent(tname)};` }) });
            if (!r.ok) { onError((await r.json().catch(() => ({}))).error || t('webpages.db.err_drop', 'Drop failed')); return; }
            if (selected === tname) setSelected(null);
            onRefresh();
        } catch (e) {
            onError(e.message);
        }
    };

    const tables = schema?.tables || [];
    const sel = tables.find(tbl => tbl.name === selected);

    return (
        <div className="flex h-full" style={{ color: 'var(--vsc-fg)' }}>
            {/* Left: table list */}
            <div className="shrink-0 border-r overflow-y-auto" style={{ width: 220, borderColor: 'var(--vsc-border)' }}>
                <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--vsc-border)' }}>
                    <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--vsc-fg-muted)' }}>
                        {unreadable && tables.length === 0
                            ? t('webpages.db.tables_unreadable_count', 'Tables (?)')
                            : t('webpages.db.tables_count', 'Tables ({count})', { count: tables.length })}
                    </span>
                    <button
                        onClick={() => setCreating(c => !c)}
                        title={t('webpages.db.new_table', 'New table')}
                        className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]"
                    >
                        <Plus size={14} />
                    </button>
                </div>
                {busy ? (
                    <div className="flex items-center justify-center py-6"><Loader2 size={14} className="animate-spin" /></div>
                ) : tables.length === 0 ? (
                    // Een MISLUKTE scan is geen lege database. "No tables yet —
                    // click + to create one" nodigt uit een tabel te maken die
                    // misschien al bestaat: de CREATE botst op de naam, of erger,
                    // de auteur kiest een andere naam en heeft er twee voor
                    // hetzelfde. Onbekend versmalt naar "ik weet het niet".
                    <div className="px-3 py-6 text-[11px]" style={{ color: unreadable ? 'var(--warning)' : 'var(--vsc-fg-muted)' }} data-testid="db-tables-empty">
                        {unreadable
                            ? t('webpages.db.tables_unknown', 'The tables could not be read, so this list is not “no tables”. Try refreshing before you create one.')
                            : t('webpages.db.no_tables', 'No tables yet — click + to create one, or use the SQL tab for a custom CREATE.')}
                    </div>
                ) : (
                    tables.map(tbl => (
                        <button
                            key={tbl.name}
                            onClick={() => setSelected(tbl.name)}
                            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left text-[12px]"
                            style={{
                                background: selected === tbl.name ? 'var(--vsc-tab-active-bg)' : 'transparent',
                                color: selected === tbl.name ? 'var(--vsc-fg)' : 'var(--vsc-fg-muted)',
                                borderLeft: selected === tbl.name ? '2px solid var(--vsc-accent)' : '2px solid transparent',
                            }}
                        >
                            <Table2 size={12} />
                            <span className="flex-1 truncate">{tbl.name}</span>
                            <span className="text-[10px]" style={{ opacity: 0.6 }}>
                                {nOf(t, 'webpages.db.n_col', tbl.columns.length, '{count} col', '{count} cols')}
                            </span>
                        </button>
                    ))
                )}
            </div>

            {/* Right: details / new-table form */}
            <div className="flex-1 overflow-y-auto p-4">
                {creating ? (
                    <div className="max-w-xl">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-semibold">{t('webpages.db.new_table', 'New table')}</h3>
                            <button onClick={() => setCreating(false)} className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]"><X size={14} /></button>
                        </div>
                        <input
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder={t('webpages.db.ph_table_name', 'table_name')}
                            className="w-full px-2 py-1.5 mb-3 text-[12px] rounded border outline-none"
                            style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-editor-bg)', color: 'var(--vsc-fg)' }}
                        />
                        <div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.db.columns', 'Columns')}</div>
                        <div className="space-y-1.5 mb-3">
                            {cols.map((c, i) => (
                                <div key={i} className="flex items-center gap-1.5">
                                    <input
                                        value={c.name}
                                        onChange={e => updateCol(i, { name: e.target.value })}
                                        placeholder={t('webpages.db.ph_column_name', 'name')}
                                        className="flex-1 px-2 py-1 text-[12px] rounded border outline-none"
                                        style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-editor-bg)', color: 'var(--vsc-fg)' }}
                                    />
                                    <select
                                        value={c.type}
                                        onChange={e => updateCol(i, { type: e.target.value })}
                                        className="px-2 py-1 text-[12px] rounded border outline-none"
                                        style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-editor-bg)', color: 'var(--vsc-fg)' }}
                                    >
                                        <option>INTEGER</option>
                                        <option>TEXT</option>
                                        <option>REAL</option>
                                        <option>BLOB</option>
                                        <option>NUMERIC</option>
                                    </select>
                                    <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                                        <input type="checkbox" checked={!!c.pk} onChange={e => updateCol(i, { pk: e.target.checked })} /> {t('webpages.db.pk', 'PK')}
                                    </label>
                                    <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                                        <input type="checkbox" checked={!!c.notnull} onChange={e => updateCol(i, { notnull: e.target.checked })} /> {t('webpages.db.not_null', 'NOT NULL')}
                                    </label>
                                    <button onClick={() => removeCol(i)} className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]" title={t('common.remove', 'Remove')}><Trash2 size={12} /></button>
                                </div>
                            ))}
                        </div>
                        <button onClick={addCol} className="text-[11px] mb-3" style={{ color: 'var(--vsc-accent)' }}>{t('webpages.db.add_column', '+ Add column')}</button>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleCreate}
                                disabled={submitting || !name.trim()}
                                className="px-3 py-1.5 rounded text-[12px] font-medium disabled:opacity-50"
                                style={{ background: 'var(--vsc-accent)', color: '#fff' }}
                            >
                                {submitting ? t('webpages.db.creating', 'Creating…') : t('webpages.create', 'Create')}
                            </button>
                            <button onClick={() => setCreating(false)} className="px-3 py-1.5 rounded text-[12px]" style={{ color: 'var(--vsc-fg-muted)' }}>{t('common.cancel', 'Cancel')}</button>
                        </div>
                    </div>
                ) : sel ? (
                    <div>
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-semibold flex items-center gap-2">
                                <Table2 size={14} /> {sel.name}
                            </h3>
                            <button
                                onClick={() => handleDropTable(sel.name)}
                                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] hover:bg-[var(--vsc-hover-bg)]"
                                style={{ color: '#ef4444' }}
                                title={t('webpages.db.drop_table', 'Drop table')}
                            >
                                <Trash2 size={12} /> {t('webpages.db.drop', 'Drop')}
                            </button>
                        </div>
                        <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ color: 'var(--vsc-fg-muted)', borderBottom: '1px solid var(--vsc-border)' }}>
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('webpages.db.col_column', 'Column')}</th>
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('common.type', 'Type')}</th>
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('webpages.db.pk', 'PK')}</th>
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('webpages.db.col_not_null', 'Not Null')}</th>
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('webpages.db.col_default', 'Default')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sel.columns.map(c => (
                                    <tr key={c.name} style={{ borderBottom: '1px solid var(--vsc-border)' }}>
                                        <td className="py-1.5 pr-3 font-mono">
                                            {c.primaryKey && <KeyRound size={11} className="inline mr-1" style={{ color: '#eab308' }} />}
                                            {c.name}
                                        </td>
                                        <td className="py-1.5 pr-3" style={{ color: 'var(--vsc-fg-muted)' }}>{c.type || '—'}</td>
                                        <td className="py-1.5 pr-3">{c.primaryKey ? '✓' : ''}</td>
                                        <td className="py-1.5 pr-3">{c.notNull ? '✓' : ''}</td>
                                        <td className="py-1.5 pr-3 font-mono" style={{ color: 'var(--vsc-fg-muted)' }}>{c.defaultValue ?? ''}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {sel.sql && (
                            <pre className="mt-4 p-2 rounded text-[11px] overflow-x-auto" style={{ background: 'var(--vsc-sidebar-bg)', color: 'var(--vsc-fg-muted)', border: '1px solid var(--vsc-border)' }}>{sel.sql}</pre>
                        )}
                    </div>
                ) : (
                    <div className="text-[12px]" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.db.select_table', 'Select a table on the left, or click + to create one.')}</div>
                )}
            </div>
            {confirmDialog}
        </div>
    );
}

// ─── Browse tab ─────────────────────────────────────────────────────

function BrowseTab({ webpageId, schema, onError }) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    // t via een ref in de lader: t is zonder TranslationProvider bij elke
    // render een nieuwe functie, en in de deps van load() zou dat het
    // laad-effect eindeloos opnieuw laten vuren.
    const tRef = useRef(t);
    tRef.current = t;
    const tables = schema?.tables || [];
    const [tableName, setTableName] = useState(null);
    const [page, setPage] = useState(0);
    const [rows, setRows] = useState([]);
    const [columns, setColumns] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [editing, setEditing] = useState(null); // { rowidx, col, value }
    const [inserting, setInserting] = useState(false);
    const [insertValues, setInsertValues] = useState({});

    useEffect(() => {
        if (!tableName && tables.length) setTableName(tables[0].name);
    }, [tables, tableName]);

    const tableMeta = tables.find(tbl => tbl.name === tableName);

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
            onError(e.message);
        } finally {
            setLoading(false);
        }
    }, [webpageId, tableName, page, onError]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { setPage(0); }, [tableName]);

    const dataColumns = columns.filter(c => c !== 'rowid');

    const startEdit = (rowidx, col, value) => {
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
            onError(e.message);
        }
    };

    const deleteRow = async (rowidx) => {
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
            onError(e.message);
        }
    };

    const handleInsert = async () => {
        if (!tableMeta) return;
        const cols = tableMeta.columns;
        const values = cols.map(c => insertValues[c.name]);
        const colNames = cols.map(c => quoteIdent(c.name)).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const sql = `INSERT INTO ${quoteIdent(tableName)} (${colNames}) VALUES (${placeholders})`;
        // Convert blank strings on integer/real columns to null so the user gets default behaviour.
        const params = cols.map((c, i) => {
            const v = values[i];
            if (v === undefined || v === '') return null;
            if (/^(INT|REAL|NUM)/i.test(c.type || '')) {
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
            onError(e.message);
        }
    };

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <div className="flex flex-col h-full" style={{ color: 'var(--vsc-fg)' }}>
            <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0" style={{ borderColor: 'var(--vsc-border)' }}>
                <Table2 size={14} style={{ color: 'var(--vsc-fg-muted)' }} />
                <select
                    value={tableName || ''}
                    onChange={e => setTableName(e.target.value)}
                    className="px-2 py-1 text-[12px] rounded border outline-none"
                    style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-editor-bg)', color: 'var(--vsc-fg)' }}
                >
                    {tables.length === 0 && <option value="">{t('webpages.db.no_tables_option', '— no tables —')}</option>}
                    {tables.map(tbl => <option key={tbl.name} value={tbl.name}>{tbl.name}</option>)}
                </select>
                <button onClick={load} className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]" title={t('webpages.refresh', 'Refresh')}>
                    <RefreshCw size={13} />
                </button>
                <div className="flex-1" />
                <span className="text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                    {nOf(t, 'webpages.db.rows', total, '{count} row', '{count} rows')}
                </span>
                <button
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="p-1 rounded hover:bg-[var(--vsc-hover-bg)] disabled:opacity-40"
                    title={t('webpages.db.prev_page', 'Previous page')}
                >
                    <ChevronLeft size={14} />
                </button>
                <span className="text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                    {page + 1} / {totalPages}
                </span>
                <button
                    onClick={() => setPage(p => p + 1 < totalPages ? p + 1 : p)}
                    disabled={page + 1 >= totalPages}
                    className="p-1 rounded hover:bg-[var(--vsc-hover-bg)] disabled:opacity-40"
                    title={t('webpages.db.next_page', 'Next page')}
                >
                    <ChevronRight size={14} />
                </button>
                <button
                    onClick={() => { setInserting(true); setInsertValues({}); }}
                    disabled={!tableMeta}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] disabled:opacity-50"
                    style={{ background: 'var(--vsc-accent)', color: '#fff' }}
                >
                    <Plus size={12} /> {t('webpages.db.insert_row', 'Insert row')}
                </button>
            </div>

            {inserting && tableMeta && (
                <div className="shrink-0 border-b p-3" style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-sidebar-bg)' }}>
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.db.new_row', 'New row')}</span>
                        <button onClick={() => setInserting(false)} className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]"><X size={12} /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-2">
                        {tableMeta.columns.map(c => (
                            <div key={c.name} className="flex flex-col">
                                <label className="text-[10px] mb-0.5" style={{ color: 'var(--vsc-fg-muted)' }}>
                                    {c.name} <span className="font-mono">{c.type}</span>{c.primaryKey ? ` · ${t('webpages.db.pk', 'PK')}` : ''}{c.notNull ? ` · ${t('webpages.db.not_null', 'NOT NULL')}` : ''}
                                </label>
                                <input
                                    value={insertValues[c.name] ?? ''}
                                    onChange={e => setInsertValues(v => ({ ...v, [c.name]: e.target.value }))}
                                    placeholder={c.defaultValue ?? (c.notNull ? t('webpages.db.required', 'required') : 'NULL')}
                                    className="px-2 py-1 text-[12px] rounded border outline-none"
                                    style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-editor-bg)', color: 'var(--vsc-fg)' }}
                                />
                            </div>
                        ))}
                    </div>
                    <button
                        onClick={handleInsert}
                        className="px-3 py-1 rounded text-[12px] font-medium"
                        style={{ background: 'var(--vsc-accent)', color: '#fff' }}
                    >
                        {t('webpages.db.insert', 'Insert')}
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-auto">
                {loading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 size={16} className="animate-spin" /></div>
                ) : !tableName ? (
                    <div className="px-3 py-8 text-[12px]" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.db.no_table_selected', 'No table selected.')}</div>
                ) : rows.length === 0 ? (
                    <div className="px-3 py-8 text-[12px]" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.db.empty_table', 'Empty table.')}</div>
                ) : (
                    <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
                        <thead style={{ position: 'sticky', top: 0, background: 'var(--vsc-sidebar-bg)' }}>
                            <tr style={{ borderBottom: '1px solid var(--vsc-border)' }}>
                                <th className="text-left px-2 py-1.5 font-mono" style={{ color: 'var(--vsc-fg-muted)' }}>rowid</th>
                                {dataColumns.map(c => (
                                    <th key={c} className="text-left px-2 py-1.5 font-mono" style={{ color: 'var(--vsc-fg-muted)' }}>{c}</th>
                                ))}
                                <th style={{ width: 32 }}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, rowidx) => (
                                <tr key={row.rowid ?? rowidx} className="hover:bg-[var(--vsc-hover-bg)]" style={{ borderBottom: '1px solid var(--vsc-border)' }}>
                                    <td className="px-2 py-1 font-mono" style={{ color: 'var(--vsc-fg-muted)' }}>{row.rowid}</td>
                                    {dataColumns.map(c => {
                                        const isEditing = editing && editing.rowidx === rowidx && editing.col === c;
                                        const v = row[c];
                                        return (
                                            <td key={c} className="px-2 py-1 font-mono" onDoubleClick={() => startEdit(rowidx, c, v)} style={{ cursor: 'text' }}>
                                                {isEditing ? (
                                                    <input
                                                        autoFocus
                                                        value={editing.value}
                                                        onChange={e => setEditing(s => ({ ...s, value: e.target.value }))}
                                                        onBlur={commitEdit}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') commitEdit();
                                                            else if (e.key === 'Escape') setEditing(null);
                                                        }}
                                                        className="w-full px-1 py-0.5 text-[12px] rounded border outline-none"
                                                        style={{ borderColor: 'var(--vsc-accent)', background: 'var(--vsc-editor-bg)', color: 'var(--vsc-fg)' }}
                                                    />
                                                ) : v === null || v === undefined ? (
                                                    <span style={{ color: 'var(--vsc-fg-muted)', fontStyle: 'italic' }}>NULL</span>
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
                                            <Trash2 size={12} style={{ color: '#ef4444' }} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
            {confirmDialog}
        </div>
    );
}

// ─── SQL tab ────────────────────────────────────────────────────────

function SqlTab({ webpageId, onError, onSchemaChanged }) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [sql, setSql] = useState('SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name;');
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState(null);
    const [resetting, setResetting] = useState(false);

    const isSelect = useMemo(() => /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql), [sql]);

    const run = async () => {
        if (!sql.trim()) return;
        setRunning(true);
        setResult(null);
        try {
            const path = isSelect ? '/db/query' : '/db/exec';
            const r = await api(webpageId, path, { method: 'POST', body: JSON.stringify({ sql }) });
            const data = await r.json();
            if (!r.ok) {
                setResult({ error: data.error || t('webpages.db.err_query', 'Query failed') });
            } else if (isSelect) {
                setResult({ kind: 'rows', rows: data.rows || [], columns: data.columns || [], truncated: !!data.truncated });
            } else {
                setResult({ kind: 'exec', changes: data.changes, lastInsertRowid: data.lastInsertRowid, multi: !!data.multi });
                    onSchemaChanged?.();
            }
        } catch (e) {
            setResult({ error: e.message });
        } finally {
            setRunning(false);
        }
    };

    const handleReset = async () => {
        if (!(await confirm({ title: t('webpages.db.confirm_reset', 'Reset the entire database? This deletes all tables and data and cannot be undone.'), confirmLabel: t('webpages.db.reset', 'Reset database'), destructive: true }))) return;
        setResetting(true);
        try {
            const r = await api(webpageId, '/db', { method: 'DELETE' });
            if (!r.ok) {
                onError((await r.json().catch(() => ({}))).error || t('webpages.db.err_reset', 'Reset failed'));
            } else {
                setResult({ kind: 'exec', changes: 0, lastInsertRowid: 0, multi: false, message: t('webpages.db.reset_done', 'Database reset.') });
                    onSchemaChanged?.();
            }
        } catch (e) {
            onError(e.message);
        } finally {
            setResetting(false);
        }
    };

    return (
        <div className="flex flex-col h-full" style={{ color: 'var(--vsc-fg)' }}>
            <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0" style={{ borderColor: 'var(--vsc-border)' }}>
                <span className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--vsc-fg-muted)' }}>
                    {isSelect ? t('webpages.db.read_query', 'Read query') : t('webpages.db.write_ddl', 'Write / DDL')}
                </span>
                <div className="flex-1" />
                <button
                    onClick={run}
                    disabled={running || !sql.trim()}
                    className="flex items-center gap-1 px-3 py-1 rounded text-[12px] font-medium disabled:opacity-50"
                    style={{ background: 'var(--vsc-accent)', color: '#fff' }}
                >
                    {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} {t('webpages.db.run', 'Run')}
                </button>
            </div>
            <textarea
                value={sql}
                onChange={e => setSql(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); }}
                spellCheck={false}
                className="shrink-0 w-full px-3 py-2 text-[12px] font-mono outline-none resize-none border-b"
                style={{ height: 140, borderColor: 'var(--vsc-border)', background: 'var(--vsc-editor-bg)', color: 'var(--vsc-fg)' }}
                placeholder={t('webpages.db.sql_placeholder', '-- Cmd/Ctrl+Enter to run')}
            />

            <div className="flex-1 overflow-auto">
                {!result ? (
                    <div className="px-3 py-3 text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                        {t('webpages.db.routing_hint', 'SELECT/WITH/PRAGMA → read query. Anything else (INSERT, CREATE, ALTER, …) → exec.')}
                    </div>
                ) : result.error ? (
                    <div className="m-3 px-3 py-2 rounded text-[12px]" style={{ background: 'rgba(239,68,68,0.1)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.3)' }}>
                        <AlertTriangle size={12} className="inline mr-1" /> {result.error}
                    </div>
                ) : result.kind === 'exec' ? (
                    <div className="m-3 px-3 py-2 rounded text-[12px]" style={{ background: 'var(--vsc-sidebar-bg)', border: '1px solid var(--vsc-border)' }}>
                        {result.message
                            ? result.message
                            : result.multi
                                ? t('webpages.db.multi_done', 'Multi-statement script executed.')
                                : result.lastInsertRowid
                                    ? nOf(t, 'webpages.db.exec_ok_id', result.changes,
                                        'OK — {count} row affected, lastInsertRowid={id}.',
                                        'OK — {count} rows affected, lastInsertRowid={id}.',
                                        { id: result.lastInsertRowid })
                                    : nOf(t, 'webpages.db.exec_ok', result.changes,
                                        'OK — {count} row affected.', 'OK — {count} rows affected.')}
                    </div>
                ) : (
                    <div className="text-[12px]">
                        <div className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                            {result.truncated
                                /* pluralKey i.p.v. nOf: de Engelse tekst bevat zelf haakjes, en de
                                   i18n-guard leest een helper-aanroep met /nOf\(([^()]*)\)/ — met
                                   haakjes in het argument ziet hij de sleutel niet, en dan reist
                                   `…_plural` ongecontroleerd. */
                                ? t(pluralKey('webpages.db.rows_truncated', result.rows.length),
                                    result.rows.length === 1
                                        ? '{count} row (truncated at 10000)'
                                        : '{count} rows (truncated at 10000)',
                                    { count: result.rows.length })
                                : nOf(t, 'webpages.db.rows', result.rows.length, '{count} row', '{count} rows')}
                        </div>
                        {result.rows.length > 0 ? (
                            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                                <thead style={{ position: 'sticky', top: 0, background: 'var(--vsc-sidebar-bg)' }}>
                                    <tr style={{ borderBottom: '1px solid var(--vsc-border)' }}>
                                        {result.columns.map(c => (
                                            <th key={c} className="text-left px-2 py-1 font-mono" style={{ color: 'var(--vsc-fg-muted)' }}>{c}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {result.rows.map((row, i) => (
                                        <tr key={i} style={{ borderBottom: '1px solid var(--vsc-border)' }}>
                                            {result.columns.map(c => (
                                                <td key={c} className="px-2 py-1 font-mono">
                                                    {row[c] === null || row[c] === undefined
                                                        ? <span style={{ color: 'var(--vsc-fg-muted)', fontStyle: 'italic' }}>NULL</span>
                                                        : <span className="block max-w-[400px] truncate" title={formatCell(row[c])}>{formatCell(row[c])}</span>}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <div className="px-3 py-3" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.db.no_rows', '(no rows)')}</div>
                        )}
                    </div>
                )}
            </div>

            {/* Danger zone */}
            <div className="shrink-0 px-3 py-2 border-t flex items-center justify-between" style={{ borderColor: 'var(--vsc-border)' }}>
                <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.db.danger_zone', 'Danger zone')}</span>
                <button
                    onClick={handleReset}
                    disabled={resetting}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] hover:bg-[var(--vsc-hover-bg)] disabled:opacity-50"
                    style={{ color: '#ef4444' }}
                    title={t('webpages.db.reset_hint', 'Drop all tables (DELETE /db)')}
                >
                    <Trash2 size={11} /> {t('webpages.db.reset', 'Reset database')}
                </button>
            </div>
            {confirmDialog}
        </div>
    );
}

// ─── Top-level viewer ───────────────────────────────────────────────

export default function WebpageDbViewer({ webpageId }) {
    const { t } = useTranslation();
    const tRef = useRef(t);
    tRef.current = t;
    const [tab, setTab] = useState('schema'); // 'schema' | 'browse' | 'sql'
    const [schema, setSchema] = useState(null);
    // "De scan is omgevallen" — een andere stand dan "er zijn geen tabellen".
    const [unreadable, setUnreadable] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const loadSchema = useCallback(async () => {
        if (!webpageId) return;
        setBusy(true);
        setError(null);
        try {
            const r = await api(webpageId, '/db/schema');
            const data = await r.json();
            if (!r.ok) {
                setError(data.error || tRef.current('webpages.db.err_schema', 'Schema lookup failed'));
                // BEWUST geen `setSchema({ tables: [] })`: dat maakte van "ik kon
                // niet kijken" een lege lijst, en de lege lijst draagt een zin
                // die een bewering is. `unreadable` houdt de twee uit elkaar.
                setUnreadable(true);
            } else {
                setSchema(data);
                setUnreadable(false);
            }
        } catch (e) {
            setError(e.message);
            setUnreadable(true);
        } finally {
            setBusy(false);
        }
    }, [webpageId]);

    useEffect(() => { loadSchema(); }, [loadSchema]);

    // Listen for AI-driven DB updates broadcast over the chat SSE stream so the
    // viewer refreshes when the model mutates the DB mid-conversation.
    useEffect(() => {
        const onAiDbUpdate = () => loadSchema();
        window.addEventListener('webpage_db_update', onAiDbUpdate);
        return () => window.removeEventListener('webpage_db_update', onAiDbUpdate);
    }, [loadSchema]);

    // Geen { key, en }-tabel: de sleutels staan hier als letterlijke t()-aanroep,
    // zodat de i18n-guard ze ziet zonder dat dit bestand op KEY_TABLE_FILES moet.
    const TABS = [
        { id: 'schema', label: t('webpages.db.tab_schema', 'Schema'), Icon: Database },
        { id: 'browse', label: t('webpages.db.tab_browse', 'Browse'), Icon: Table2 },
        { id: 'sql', label: t('webpages.db.tab_sql', 'SQL'), Icon: Play },
    ];

    return (
        <div className="flex flex-col h-full" style={{ background: 'var(--vsc-editor-bg)', color: 'var(--vsc-fg)' }}>
            <div className="flex items-center shrink-0 border-b" style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-sidebar-bg)' }}>
                {TABS.map(({ id, label, Icon }) => (
                    <button
                        key={id}
                        onClick={() => setTab(id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[12px]"
                        style={{
                            background: tab === id ? 'var(--vsc-tab-active-bg)' : 'transparent',
                            color: tab === id ? 'var(--vsc-fg)' : 'var(--vsc-fg-muted)',
                            borderRight: '1px solid var(--vsc-border)',
                            borderTop: tab === id ? '2px solid var(--vsc-accent)' : '2px solid transparent',
                        }}
                    >
                        <Icon size={13} /> {label}
                    </button>
                ))}
                <div className="flex-1" />
                <button
                    onClick={loadSchema}
                    title={t('webpages.db.refresh_schema', 'Refresh schema')}
                    className="flex items-center gap-1 px-2 py-1 mr-2 rounded text-[11px] hover:bg-[var(--vsc-hover-bg)]"
                    style={{ color: 'var(--vsc-fg-muted)' }}
                >
                    <RefreshCw size={12} /> {t('webpages.refresh', 'Refresh')}
                </button>
            </div>

            {error && (
                <div className="m-2 px-2 py-1 rounded text-[11px]" style={{ background: 'rgba(239,68,68,0.1)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.3)' }}>
                    {error}
                </div>
            )}

            <div className="flex-1 min-h-0">
                {tab === 'schema' && (
                    <SchemaTab webpageId={webpageId} schema={schema} onRefresh={loadSchema} busy={busy} onError={setError} unreadable={unreadable} />
                )}
                {tab === 'browse' && (
                    <BrowseTab webpageId={webpageId} schema={schema} onError={setError}  />
                )}
                {tab === 'sql' && (
                    <SqlTab webpageId={webpageId} onError={setError}  onSchemaChanged={loadSchema} />
                )}
            </div>
        </div>
    );
}
