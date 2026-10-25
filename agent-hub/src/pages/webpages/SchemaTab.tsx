import { Table2, Plus, Trash2, Loader2, KeyRound, X } from 'lucide-react';
import type { ColumnDraft, DbColumn, DbTable, SchemaTabProps } from './WebpageDbViewer.types';
import React, { useState, useEffect, useMemo } from 'react';
import { nOf } from '../../components/admin/Studio/KnowledgeStudio/plural';
import useConfirm from '../../components/shared/useConfirm';
import useTranslation, { TranslateParams } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { quoteIdent, api } from './BrowseTab';

export function SchemaTab({ webpageId, schema, onRefresh, busy, onError, unreadable = false }: SchemaTabProps) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [cols, setCols] = useState<ColumnDraft[]>([{ name: 'id', type: 'INTEGER', pk: true, notnull: true }]);
    const [submitting, setSubmitting] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);

    useEffect(() => {
        if (!selected && schema?.tables?.length) setSelected(schema.tables[0].name);
    }, [schema, selected]);

    const addCol = () => setCols((cs: ColumnDraft[]) => [...cs, { name: '', type: 'TEXT', pk: false, notnull: false }]);
    const updateCol = (i: number, patch: Partial<ColumnDraft>) => setCols((cs: ColumnDraft[]) => cs.map((c: ColumnDraft, idx: number) => idx === i ? { ...c, ...patch } : c));
    const removeCol = (i: number) => setCols((cs: ColumnDraft[]) => cs.filter((_: ColumnDraft, idx: number) => idx !== i));

    const handleCreate = async () => {
        if (!name.trim()) return;
        const validCols = cols.filter((c: ColumnDraft) => c.name.trim());
        if (validCols.length === 0) { onError(t('webpages.db.err_no_columns', 'Add at least one column')); return; }
        const colSql = validCols.map((c: ColumnDraft) => {
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
            onError(errorMessage(e));
        } finally {
            setSubmitting(false);
        }
    };

    const handleDropTable = async (tname: string) => {
        if (!(await confirm({ title: t('webpages.db.confirm_drop', 'Drop table "{name}"? This cannot be undone.', { name: tname }), confirmLabel: t('common.delete', 'Delete'), destructive: true }))) return;
        try {
            const r = await api(webpageId, '/db/exec', { method: 'POST', body: JSON.stringify({ sql: `DROP TABLE ${quoteIdent(tname)};` }) });
            if (!r.ok) { onError((await r.json().catch(() => ({}))).error || t('webpages.db.err_drop', 'Drop failed')); return; }
            if (selected === tname) setSelected(null);
            onRefresh();
        } catch (e) {
            onError(errorMessage(e));
        }
    };

    const tables = useMemo(() => schema?.tables || [], [schema?.tables]);
    const sel = tables.find((tbl: DbTable) => tbl.name === selected);

    return (
        <div className="flex h-full text-[var(--vsc-fg)]">
            {/* Left: table list */}
            <SchemaTabSection unreadable={unreadable} tables={tables} t={t} setCreating={setCreating} busy={busy} setSelected={setSelected} selected={selected} />

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
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                            placeholder={t('webpages.db.ph_table_name', 'table_name')}
                            className="w-full px-2 py-1.5 mb-3 text-[12px] rounded border outline-none [border-color:var(--vsc-border)] [background:var(--vsc-editor-bg)] [color:var(--vsc-fg)]!"
                        />
                        <div className="text-[11px] uppercase tracking-wider mb-1 text-[var(--vsc-fg-muted)]">{t('webpages.db.columns', 'Columns')}</div>
                        <div className="space-y-1.5 mb-3">
                            {cols.map((c: ColumnDraft, i: number) => (
                                <div key={i} className="flex items-center gap-1.5">
                                    <input
                                        value={c.name}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateCol(i, { name: e.target.value })}
                                        placeholder={t('webpages.db.ph_column_name', 'name')}
                                        className="flex-1 px-2 py-1 text-[12px] rounded border outline-none [border-color:var(--vsc-border)] [background:var(--vsc-editor-bg)] [color:var(--vsc-fg)]!"
                                    />
                                    <select
                                        value={c.type}
                                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => updateCol(i, { type: e.target.value })}
                                        className="px-2 py-1 text-[12px] rounded border outline-none [border-color:var(--vsc-border)] [background:var(--vsc-editor-bg)] [color:var(--vsc-fg)]!"
                                    >
                                        <option>INTEGER</option>
                                        <option>TEXT</option>
                                        <option>REAL</option>
                                        <option>BLOB</option>
                                        <option>NUMERIC</option>
                                    </select>
                                    <label className="flex items-center gap-1 text-[11px] text-[var(--vsc-fg-muted)]">
                                        <input type="checkbox" checked={!!c.pk} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateCol(i, { pk: e.target.checked })} /> {t('webpages.db.pk', 'PK')}
                                    </label>
                                    <label className="flex items-center gap-1 text-[11px] text-[var(--vsc-fg-muted)]">
                                        <input type="checkbox" checked={!!c.notnull} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateCol(i, { notnull: e.target.checked })} /> {t('webpages.db.not_null', 'NOT NULL')}
                                    </label>
                                    <button onClick={() => removeCol(i)} className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]" title={t('common.remove', 'Remove')}><Trash2 size={12} /></button>
                                </div>
                            ))}
                        </div>
                        <button onClick={addCol} className="text-[11px] mb-3 text-[var(--vsc-accent)]">{t('webpages.db.add_column', '+ Add column')}</button>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleCreate}
                                disabled={submitting || !name.trim()}
                                className="px-3 py-1.5 rounded text-[12px] font-medium disabled:opacity-50 [background:var(--vsc-accent)] [color:#fff]!"
                            >
                                {submitting ? t('webpages.db.creating', 'Creating…') : t('webpages.create', 'Create')}
                            </button>
                            <button onClick={() => setCreating(false)} className="px-3 py-1.5 rounded text-[12px] text-[var(--vsc-fg-muted)]">{t('common.cancel', 'Cancel')}</button>
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
                                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] hover:bg-[var(--vsc-hover-bg)] [color:#ef4444]!"
                                title={t('webpages.db.drop_table', 'Drop table')}
                            >
                                <Trash2 size={12} /> {t('webpages.db.drop', 'Drop')}
                            </button>
                        </div>
                        <table className="w-full text-[12px] [border-collapse:collapse]">
                            <thead>
                                <tr className="[color:var(--vsc-fg-muted)] [border-bottom:1px_solid_var(--vsc-border)]">
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('webpages.db.col_column', 'Column')}</th>
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('common.type', 'Type')}</th>
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('webpages.db.pk', 'PK')}</th>
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('webpages.db.col_not_null', 'Not Null')}</th>
                                    <th className="text-left py-1.5 pr-3 font-medium">{t('webpages.db.col_default', 'Default')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sel.columns.map((c: DbColumn) => (
                                    <tr key={c.name} className="[border-bottom:1px_solid_var(--vsc-border)]">
                                        <td className="py-1.5 pr-3 font-mono">
                                            {c.primaryKey && <KeyRound size={11} className="inline mr-1 [color:#eab308]" />}
                                            {c.name}
                                        </td>
                                        <td className="py-1.5 pr-3 text-[var(--vsc-fg-muted)]">{c.type || '—'}</td>
                                        <td className="py-1.5 pr-3">{c.primaryKey ? '✓' : ''}</td>
                                        <td className="py-1.5 pr-3">{c.notNull ? '✓' : ''}</td>
                                        <td className="py-1.5 pr-3 font-mono text-[var(--vsc-fg-muted)]">{c.defaultValue ?? ''}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {sel.sql && (
                            <pre className="mt-4 p-2 rounded text-[11px] overflow-x-auto [background:var(--vsc-sidebar-bg)] [color:var(--vsc-fg-muted)]! [border:1px_solid_var(--vsc-border)]">{sel.sql}</pre>
                        )}
                    </div>
                ) : (
                    <div className="text-[12px] text-[var(--vsc-fg-muted)]">{t('webpages.db.select_table', 'Select a table on the left, or click + to create one.')}</div>
                )}
            </div>
            {confirmDialog}
        </div>
    );
}

function SchemaTabSection({ unreadable, tables, t, setCreating, busy, setSelected, selected }: { unreadable: boolean; tables: DbTable[]; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; setCreating: React.Dispatch<React.SetStateAction<boolean>>; busy: boolean; setSelected: React.Dispatch<React.SetStateAction<string | null>>; selected: string | null; }) {
    return <div className="shrink-0 border-r overflow-y-auto w-[220px] [border-color:var(--vsc-border)]!">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--vsc-border)]">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--vsc-fg-muted)]">
                {unreadable && tables.length === 0
                    ? t('webpages.db.tables_unreadable_count', 'Tables (?)')
                    : t('webpages.db.tables_count', 'Tables ({count})', { count: tables.length })}
            </span>
            <button
                onClick={() => setCreating((c: boolean) => !c)}
                title={t('webpages.db.new_table', 'New table')}
                className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]"
            >
                <Plus size={14} />
            </button>
        </div>
        {busy ? (
            <div className="flex items-center justify-center py-6"><Loader2 size={14} className="animate-spin" /></div>
        ) : tables.length === 0 ? (
            // A FAILED scan is not an empty database. "No tables yet —
            // click + to create one" invites making a table that may already exist:
            // the CREATE collides with the name, or worse, the author picks another
            // name and has two for the same thing. Unknown narrows to "I do not know".
            <div className="px-3 py-6 text-[11px]" style={{ color: unreadable ? 'var(--warning)' : 'var(--vsc-fg-muted)' }} data-testid="db-tables-empty">
                {unreadable
                    ? t('webpages.db.tables_unknown', 'The tables could not be read, so this list is not “no tables”. Try refreshing before you create one.')
                    : t('webpages.db.no_tables', 'No tables yet — click + to create one, or use the SQL tab for a custom CREATE.')}
            </div>
        ) : (
            tables.map((tbl: DbTable) => (
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
                    <span className="text-[10px] [opacity:0.6]">
                        {nOf(t, 'webpages.db.n_col', tbl.columns.length, '{count} col', '{count} cols')}
                    </span>
                </button>
            ))
        )}
    </div>;
}
