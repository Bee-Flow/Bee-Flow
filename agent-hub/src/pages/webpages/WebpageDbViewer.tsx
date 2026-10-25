import { Database, Table2, Play, RefreshCw, Trash2, AlertTriangle, Loader2 } from 'lucide-react';
import type { DbRow, DbSchema, Props, SqlResult, SqlTabProps, TabDef } from './WebpageDbViewer.types';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { nOf, pluralKey } from '../../components/admin/Studio/KnowledgeStudio/plural';
import useConfirm from '../../components/shared/useConfirm';
import useTranslation from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { formatCell, api, BrowseTab } from './BrowseTab';
import { SchemaTab } from './SchemaTab';

/**
 * WebpageDbViewer — three-tab UI on top of the per-webpage SQLite DB.
 *
 *   Schema  list tables + their columns (click + new-table form)
 *   Browse  pick a table, page through rows, edit/insert/delete
 *   SQL     free-form editor; auto-routes SELECT → /db/query, else → /db/exec
 * Endpoints (server/routes/webpages.js): GET /api/webpages/:id/db/schema,
 * POST .../db/query and .../db/exec ({ sql, params? }), DELETE .../db
 */

// ─── Schema tab ─────────────────────────────────────────────────────

// ─── Browse tab ─────────────────────────────────────────────────────

// ─── SQL tab ────────────────────────────────────────────────────────

function SqlTab({ webpageId, onError, onSchemaChanged }: SqlTabProps) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [sql, setSql] = useState('SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name;');
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<SqlResult | null>(null);
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
            setResult({ error: errorMessage(e) });
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
            onError(errorMessage(e));
        } finally {
            setResetting(false);
        }
    };

    return (
        <div className="flex flex-col h-full text-[var(--vsc-fg)]">
            <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0 border-[var(--vsc-border)]">
                <span className="text-[11px] uppercase tracking-wider text-[var(--vsc-fg-muted)]">
                    {isSelect ? t('webpages.db.read_query', 'Read query') : t('webpages.db.write_ddl', 'Write / DDL')}
                </span>
                <div className="flex-1" />
                <button
                    onClick={run}
                    disabled={running || !sql.trim()}
                    className="flex items-center gap-1 px-3 py-1 rounded text-[12px] font-medium disabled:opacity-50 [background:var(--vsc-accent)] [color:#fff]!"
                >
                    {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} {t('webpages.db.run', 'Run')}
                </button>
            </div>
            <textarea
                value={sql}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setSql(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); }}
                spellCheck={false}
                className="shrink-0 w-full px-3 py-2 text-[12px] font-mono outline-none resize-none border-b h-[140px] [border-color:var(--vsc-border)]! [background:var(--vsc-editor-bg)] [color:var(--vsc-fg)]!"
                placeholder={t('webpages.db.sql_placeholder', '-- Cmd/Ctrl+Enter to run')}
            />

            <div className="flex-1 overflow-auto">
                {!result ? (
                    <div className="px-3 py-3 text-[11px] text-[var(--vsc-fg-muted)]">
                        {t('webpages.db.routing_hint', 'SELECT/WITH/PRAGMA → read query. Anything else (INSERT, CREATE, ALTER, …) → exec.')}
                    </div>
                ) : result.error ? (
                    <div className="m-3 px-3 py-2 rounded text-[12px] [background:rgba(239,68,68,0.1)] [color:#dc2626]! [border:1px_solid_rgba(239,68,68,0.3)]">
                        <AlertTriangle size={12} className="inline mr-1" /> {result.error}
                    </div>
                ) : result.kind === 'exec' ? (
                    <div className="m-3 px-3 py-2 rounded text-[12px] [background:var(--vsc-sidebar-bg)] [border:1px_solid_var(--vsc-border)]">
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
                        <div className="px-3 py-1.5 text-[11px] text-[var(--vsc-fg-muted)]">
                            {result.truncated
                                /* pluralKey instead of nOf: the English text itself contains brackets, and the
                                   i18n guard reads a helper call with /nOf\(([^()]*)\)/ — with brackets in
                                   the argument it does not see the key, and then `…_plural` travels
                                   unchecked. */
                                ? t(pluralKey('webpages.db.rows_truncated', (result.rows as DbRow[]).length),
                                    (result.rows as DbRow[]).length === 1
                                        ? '{count} row (truncated at 10000)'
                                        : '{count} rows (truncated at 10000)',
                                    { count: (result.rows as DbRow[]).length })
                                : nOf(t, 'webpages.db.rows', (result.rows as DbRow[]).length, '{count} row', '{count} rows')}
                        </div>
                        {(result.rows as DbRow[]).length > 0 ? (
                            <table className="[border-collapse:collapse] w-[100%]">
                                <thead className="[position:sticky] [top:0] [background:var(--vsc-sidebar-bg)]">
                                    <tr className="[border-bottom:1px_solid_var(--vsc-border)]">
                                        {(result.columns as string[]).map((c: string) => (
                                            <th key={c} className="text-left px-2 py-1 font-mono text-[var(--vsc-fg-muted)]">{c}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {(result.rows as DbRow[]).map((row: DbRow, i: number) => (
                                        <tr key={i} className="[border-bottom:1px_solid_var(--vsc-border)]">
                                            {(result.columns as string[]).map((c: string) => (
                                                <td key={c} className="px-2 py-1 font-mono">
                                                    {row[c] === null || row[c] === undefined
                                                        ? <span className="[color:var(--vsc-fg-muted)] [font-style:italic]">NULL</span>
                                                        : <span className="block max-w-[400px] truncate" title={formatCell(row[c])}>{formatCell(row[c])}</span>}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <div className="px-3 py-3 text-[var(--vsc-fg-muted)]">{t('webpages.db.no_rows', '(no rows)')}</div>
                        )}
                    </div>
                )}
            </div>

            {/* Danger zone */}
            <div className="shrink-0 px-3 py-2 border-t flex items-center justify-between border-[var(--vsc-border)]">
                <span className="text-[10px] uppercase tracking-wider text-[var(--vsc-fg-muted)]">{t('webpages.db.danger_zone', 'Danger zone')}</span>
                <button
                    onClick={handleReset}
                    disabled={resetting}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] hover:bg-[var(--vsc-hover-bg)] disabled:opacity-50 [color:#ef4444]!"
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

export default function WebpageDbViewer({ webpageId }: Props) {
    const { t } = useTranslation();
    const tRef = useRef(t);
    tRef.current = t;
    const [tab, setTab] = useState('schema'); // 'schema' | 'browse' | 'sql'
    const [schema, setSchema] = useState<DbSchema | null>(null);
    // "The scan has failed" — a different state from "there are no tables".
    const [unreadable, setUnreadable] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null | undefined>(null);

    const loadSchema = useCallback(async () => {
        if (!webpageId) return;
        setBusy(true);
        setError(null);
        try {
            const r = await api(webpageId, '/db/schema');
            const data = await r.json();
            if (!r.ok) {
                setError(data.error || tRef.current('webpages.db.err_schema', 'Schema lookup failed'));
                // DELIBERATELY no `setSchema({ tables: [] })`: that turned "I could not look"
                // into an empty list, and the empty list carries a sentence that is a claim.
                // `unreadable` keeps the two apart.
                setUnreadable(true);
            } else {
                setSchema(data);
                setUnreadable(false);
            }
        } catch (e) {
            setError(errorMessage(e));
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

    // Not a { key, en } table: the keys stand here as literal t() calls, so that the
    // i18n guard sees them without this file having to be on KEY_TABLE_FILES.
    const TABS: TabDef[] = [
        { id: 'schema', label: t('webpages.db.tab_schema', 'Schema'), Icon: Database },
        { id: 'browse', label: t('webpages.db.tab_browse', 'Browse'), Icon: Table2 },
        { id: 'sql', label: t('webpages.db.tab_sql', 'SQL'), Icon: Play },
    ];

    return (
        <div className="flex flex-col h-full bg-[var(--vsc-editor-bg)] text-[var(--vsc-fg)]">
            <div className="flex items-center shrink-0 border-b border-[var(--vsc-border)] bg-[var(--vsc-sidebar-bg)]">
                {TABS.map(({ id, label, Icon }: TabDef) => (
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
                    className="flex items-center gap-1 px-2 py-1 mr-2 rounded text-[11px] hover:bg-[var(--vsc-hover-bg)] text-[var(--vsc-fg-muted)]"
                >
                    <RefreshCw size={12} /> {t('webpages.refresh', 'Refresh')}
                </button>
            </div>

            {error && (
                <div className="m-2 px-2 py-1 rounded text-[11px] [background:rgba(239,68,68,0.1)] [color:#dc2626]! [border:1px_solid_rgba(239,68,68,0.3)]">
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
