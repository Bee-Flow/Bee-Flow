import { AlertTriangle, CheckCircle2, CornerDownRight, Database, Loader2, RefreshCw, Table2, Zap } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { runWithSave, saveFirstLabel, saveFirstReason } from './saveGate';
import { tRich } from './tRich';
import useTranslation from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import { studioAppsApi } from '../studioAppsApi';

/** `tbl_`/`fld_` ids, mirroring the server's id shape. */
function tableId() { return `tbl_${Math.random().toString(36).slice(2, 8)}`; }
function fieldId() { return `fld_${Math.random().toString(36).slice(2, 8)}`; }

/** A catalog table TEMPLATE (keys + types, no ids) → a real table. */
function materialiseTable(template, preferredKey, existing = []) {
    const taken = new Set((existing || []).map((t) => t.key));
    let key = preferredKey;
    let n = 2;
    while (taken.has(key)) key = `${preferredKey}_${n++}`;
    return {
        id: tableId(),
        key,
        name: template.name,
        icon: template.icon || null,
        fields: (template.fields || []).map((f) => ({ ...f, id: fieldId() })),
        access: { default: 'app' },
    };
}

/**
 * App Studio — "keep this in a table".
 *
 * A connector without this fetches from the upstream API on every viewer, every
 * screen paint. With it, the rows land in one of the app's own tables and the
 * app reads locally; the upstream is touched once per refresh interval for the
 * whole audience.
 *
 * Setup is one click because the server already worked everything out. POST
 * /inspect runs the connector once and answers with the columns, the field that
 * identifies a row, and whether incremental loading is possible AT ALL — so this
 * panel proposes rather than asks. The owner confirms; nothing is typed.
 *
 * ── THE HONEST BIT ──────────────────────────────────────────────────
 * Incremental loading is only offered when the data supports it, and the copy
 * says which of the two kinds you get, because they are not equally good:
 *
 *   request — the action takes a "changed since" parameter, so only changed
 *             records are fetched. Genuinely cheaper upstream.
 *   client  — no such parameter exists, so everything is fetched and only
 *             changed rows are written. Cheaper for the database, NOT for the
 *             API. Saying otherwise would be a lie the owner discovers via a
 *             rate limit.
 *   none    — no timestamp anywhere; the option is not rendered at all.
 */

const INPUT = 'w-full rounded-md px-2 py-1.5 text-sm bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)]';
const LABEL = 'text-xs font-medium text-[var(--text-secondary)]';

const intervals = (t) => [
    { minutes: 15, label: t('studio_apps_bi.sync.every_15_min', 'Every 15 minutes') },
    { minutes: 60, label: t('studio_apps_bi.sync.every_hour', 'Every hour') },
    { minutes: 360, label: t('studio_apps_bi.sync.every_6_hours', 'Every 6 hours') },
    { minutes: 1440, label: t('studio_apps_bi.sync.once_a_day', 'Once a day') },
];

/**
 * A mailbox may poll far more often than anything else — an inbox that notices
 * a customer's mail a quarter of an hour late is not an inbox. The floor is
 * enforced server-side per connector kind (dataModel.MIN_SYNC_MINUTES_BY_KIND);
 * these are just the choices we offer.
 */
const mailboxIntervals = (t) => [
    { minutes: 2, label: t('studio_apps_bi.sync.every_2_min', 'Every 2 minutes') },
    { minutes: 5, label: t('studio_apps_bi.sync.every_5_min', 'Every 5 minutes') },
    ...intervals(t),
];

function intervalsFor(kind, t) {
    return kind === 'mailbox' ? mailboxIntervals(t) : intervals(t);
}

function incrementalCopy(connector, incremental, t) {
    if (connector?.kind === 'mailbox') return mailboxIncrementalCopy(incremental.field, t);
    return incrementalModeCopy(incremental.param ? 'request' : 'client', incremental.field, incremental.param, t);
}

function incrementalModeCopy(mode, field, param, t) {
    if (mode === 'request') {
        return {
            title: t('studio_apps_bi.sync.incr_request_title', 'Only fetch what changed'),
            body: t('studio_apps_bi.sync.incr_request_body', 'This action can filter on “{param}”, so each refresh asks for records changed since the last one. Fewest calls, least data.', { param }),
            field,
        };
    }
    return {
        title: t('studio_apps_bi.sync.incr_client_title', 'Only save what changed'),
        body: t('studio_apps_bi.sync.incr_client_body', 'This action can’t filter by date, so every refresh still fetches the full list — but only rows with a newer “{field}” are written. It keeps the table quiet; it does not reduce API calls.', { field }),
        field,
    };
}

/**
 * A mailbox filters by date at the provider, so the generic "this action can't
 * filter by date" copy above is simply wrong for it — it would tell someone
 * their inbox re-downloads itself every two minutes when it does not.
 */
const mailboxIncrementalCopy = (field, t) => ({
    title: t('studio_apps_bi.sync.incr_mail_title', 'Only fetch new mail'),
    body: t('studio_apps_bi.sync.incr_mail_body', 'Each refresh asks the mail provider for messages received since the last one, with a short overlap so nothing slips through. Only rows with a newer “{field}” are written.', { field }),
    field,
});

function relative(iso, t) {
    if (!iso) return t('studio_apps_bi.sync.never', 'never');
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff)) return t('studio_apps_bi.sync.never', 'never');
    const mins = Math.round(diff / 60000);
    if (mins < 1) return t('studio_apps_bi.sync.just_now', 'just now');
    if (mins < 60) return t('studio_apps_bi.sync.min_ago', '{n} min ago', { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t('studio_apps_bi.sync.hours_ago', '{n} h ago', { n: hours });
    return t('studio_apps_bi.sync.days_ago', '{n} d ago', { n: Math.round(hours / 24) });
}

export default function ConnectorSyncPanel({
    connector, tables = [], appId, onChange, onCreateTable, onCreateTables, disabled = false, saved = true,
    onSave = null,
}) {
    const { t } = useTranslation();
    const sync = connector.sync || null;
    const table = sync ? tables.find((t) => t.id === sync.tableId) : null;
    const isMailbox = connector.kind === 'mailbox';

    const [proposal, setProposal] = useState(null);   // /inspect result
    const [busy, setBusy] = useState(null);           // 'inspect' | 'sync'
    const [error, setError] = useState(null);
    const [status, setStatus] = useState(null);       // last run state
    const [runResult, setRunResult] = useState(null);

    // Last run / next run / last error, so a silently failing schedule is visible
    // rather than something the owner discovers from stale data.
    useEffect(() => {
        if (!appId || !sync) return undefined;
        let alive = true;
        authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/connectors/sync-status`)
            .then((r) => (r.ok ? r.json() : null))
            .then((b) => {
                if (!alive || !b) return;
                setStatus((b.syncs || []).find((s) => s.connectorId === connector.id) || null);
            })
            .catch(() => { /* status is advisory */ });
        return () => { alive = false; };
    }, [appId, connector.id, sync, runResult]);

    const call = async (path, label) => {
        setBusy(label);
        setError(null);
        try {
            const res = await authFetch(
                `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/connectors/${encodeURIComponent(connector.id)}/${path}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
            );
            let body = null;
            try { body = await res.json(); } catch { body = null; }
            if (!res.ok) {
                // A missing connection is the one failure with an obvious fix,
                // so it gets said in those terms rather than as a raw error.
                if (body?.code === 'connection_required') {
                    setError(t('studio_apps_bi.sync.err_connect', 'Connect {app} to your account first (Settings → Integrations), then try again.', { app: body.provider || connector.integrationId || t('studio_apps_bi.sync.err_connect_that_app', 'that app') }));
                } else if (res.status === 404) {
                    setError(t('studio_apps_bi.sync.err_save_first', 'Save your changes first — this always runs the last saved version of the connector.'));
                } else {
                    setError(body?.error || t('studio_apps_bi.sync.err_failed', 'It did not work ({status}).', { status: res.status }));
                }
                return null;
            }
            return body;
        } catch (e) {
            setError(e.message || t('studio_apps_bi.sync.err_unreachable', 'Could not reach the server.'));
            return null;
        } finally {
            setBusy(null);
        }
    };

    const inspect = async () => {
        const body = await call('inspect', 'inspect');
        if (body) setProposal(body);
    };

    /**
     * A mailbox needs no inspection: its columns are fixed, so the table can be
     * built here and now. That is not a shortcut — it breaks a deadlock. Every
     * other connector kind must be RUN once to discover its shape, which needs a
     * saved connector; but a mailbox connector cannot be saved without a table,
     * so "Set up a table" was disabled with "Save your changes first" while Save
     * refused for want of a table. There was no way out of that dialog.
     */
    const createMailboxTables = async () => {
        setBusy('inspect');
        setError(null);
        try {
            const catalog = await studioAppsApi.getCatalog();
            const templates = catalog?.mailboxTables;
            if (!templates?.message) throw new Error(t('studio_apps_bi.sync.err_no_mailbox_tables', 'This server does not describe the mailbox tables.'));

            const threaded = connector.groupIntoThreads === true;
            const built = (template, key) => materialiseTable(template, key, tables);

            if (threaded) {
                const threads = built(templates.thread, 'tickets');
                const messages = built(templates.message, 'messages');
                onCreateTables?.([threads, messages], {
                    tableId: threads.id,
                    mode: 'upsert',
                    keyField: 'thread_key',
                    incremental: { field: 'last_message_at', format: 'iso' },
                    schedule: { everyMinutes: 2 },
                    refreshOnView: true,
                    retentionDays: 90,
                    children: [{
                        tableId: messages.id, level: 1, parentLevel: 0,
                        relationField: 'ticket', keyField: 'provider_message_id', mode: 'upsert',
                    }],
                });
            } else {
                const messages = built(templates.message, 'messages');
                onCreateTable?.(messages, {
                    tableId: messages.id,
                    mode: 'upsert',
                    keyField: 'provider_message_id',
                    incremental: { field: 'received_at', format: 'iso' },
                    schedule: { everyMinutes: 2 },
                    refreshOnView: true,
                    retentionDays: 90,
                });
            }
        } catch (e) {
            setError(e.message || t('studio_apps_bi.sync.err_create_table', 'Could not create the table.'));
        } finally {
            setBusy(null);
        }
    };

    const refreshNow = async () => {
        const body = await call('sync', 'sync');
        if (body) setRunResult(body);
    };

    const accept = () => {
        if (!proposal) return;
        const inc = proposal.incremental || {};
        const incrementalBlock = inc.mode && inc.mode !== 'none'
            ? { incremental: { field: inc.field, ...(inc.param ? { param: inc.param } : {}), format: inc.format || 'iso' } }
            : {};

        // A chain that expanded proposes RELATED tables — one per grain, joined
        // by a relation column — rather than one wide table that would repeat
        // every parent field once per child.
        const set = proposal.tableSet?.tables;
        if (set && set.length > 1) {
            const [parent, ...children] = set;
            onCreateTables?.(set.map((t) => t.table), {
                tableId: parent.table.id,
                mode: parent.defaultMode,
                ...(parent.keyField ? { keyField: parent.keyField } : {}),
                ...incrementalBlock,
                schedule: { everyMinutes: 60 },
                refreshOnView: true,
                children: children.map((c) => ({
                    tableId: c.table.id,
                    level: c.level,
                    parentLevel: c.parentLevel ?? 0,
                    relationField: c.relationField,
                    mode: c.defaultMode,
                    ...(c.keyField ? { keyField: c.keyField } : {}),
                })),
            });
            setProposal(null);
            return;
        }

        onCreateTable?.(proposal.suggestedTable, {
            tableId: proposal.suggestedTable.id,
            mode: proposal.defaultMode,
            ...(proposal.keyField ? { keyField: proposal.keyField } : {}),
            ...incrementalBlock,
            schedule: { everyMinutes: 60 },
            refreshOnView: true,
        });
        setProposal(null);
    };

    const patchSync = (patch) => onChange({ sync: { ...sync, ...patch } });

    // ── Not set up yet ──────────────────────────────────────────────
    if (!sync) {
        return (
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    <Database className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                    {t('studio_apps_bi.sync.keep_in_table', 'Keep this in a table')}
                </div>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('studio_apps_bi.sync.keep_intro', 'Store what this connector returns in one of your app’s tables. The app then reads the table instead of calling {app} on every screen — faster for viewers, and far fewer API calls.', { app: connector.integrationId || t('studio_apps_bi.sync.the_app', 'the app') })}
                </p>

                {proposal ? (
                    <div className="mt-2.5 flex flex-col gap-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-tertiary)' }}>
                        {(() => {
                            const set = proposal.tableSet?.tables;
                            // A chain whose steps returned different things
                            // ("messages", their content, "attachments") gets one
                            // linked table each, rather than one wide table that
                            // repeats every message once per attachment.
                            if (set && set.length > 1) {
                                return (
                                    <>
                                        <p className="text-xs" style={{ color: 'var(--text-primary)' }}>
                                            {t('studio_apps_bi.sync.steps_return', 'Your steps return {n} different things, so they get {n} linked tables:', { n: set.length })}
                                        </p>
                                        {set.map((tb, i) => (
                                            <div key={tb.table.id} className="flex flex-col gap-0.5" style={{ paddingLeft: i ? '1rem' : 0 }}>
                                                <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-primary)' }}>
                                                    {i ? <CornerDownRight className="h-3.5 w-3.5" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                                                        : <Table2 className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />}
                                                    {tb.table.name}
                                                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                                        {tb.rowCount === 1
                                                            ? t('studio_apps_bi.sync.table_summary_one', '— {cols} columns, 1 row', { cols: tb.table.fields.length })
                                                            : t('studio_apps_bi.sync.table_summary_many', '— {cols} columns, {rows} rows', { cols: tb.table.fields.length, rows: tb.rowCount })}
                                                    </span>
                                                </div>
                                                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                                    {!i
                                                        ? <>{tb.identity ? tRich(t, 'studio_apps_bi.sync.matched_on', 'matched on {field}', null, { field: <code>{tb.identity}</code> }) : t('studio_apps_bi.sync.replaced_every_refresh', 'replaced on every refresh')}</>
                                                        : tb.expandFrom
                                                            // A fan-out: many children per parent.
                                                            ? <>{tRich(t, 'studio_apps_bi.sync.one_row_per_linked', 'one row per {item}, linked back to {table} through {field}', { item: String(tb.expandFrom).replace(/s$/, ''), table: set[tb.parentLevel ?? 0].table.name }, { field: <code>{tb.relationField}</code> })}</>
                                                            // A step kept in its own table: exactly one child per parent,
                                                            // so saying "one row per item" here would be wrong.
                                                            : <>{tRich(t, 'studio_apps_bi.sync.one_row_per_parent_row', 'one row per {table} row, linked to it through {field}', { table: set[tb.parentLevel ?? 0].table.name }, { field: <code>{tb.relationField}</code> })}</>}
                                                </p>
                                            </div>
                                        ))}
                                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                            {t('studio_apps_bi.sync.link_auto', 'The link is filled in automatically each refresh — you don’t have to match them up.')}
                                        </p>
                                    </>
                                );
                            }
                            return (
                                <>
                                    <p className="text-xs" style={{ color: 'var(--text-primary)' }}>
                                        {proposal.rowCount === 1
                                            ? t('studio_apps_bi.sync.got_one_row', 'Got 1 row back. Here’s the table that fits:')
                                            : t('studio_apps_bi.sync.got_rows', 'Got {n} rows back. Here’s the table that fits:', { n: proposal.rowCount })}
                                    </p>
                                    <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-primary)' }}>
                                        <Table2 className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                                        {proposal.suggestedTable.name}
                                        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                            {t('studio_apps_bi.sync.columns_summary', '— {cols} columns', { cols: proposal.suggestedTable.fields.length })}
                                        </span>
                                    </div>
                                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                        {proposal.suggestedTable.fields.slice(0, 8).map((f) => f.key).join(', ')}
                                        {proposal.suggestedTable.fields.length > 8 ? '…' : ''}
                                    </p>
                                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                        {proposal.identity
                                            ? tRich(t, 'studio_apps_bi.sync.rows_matched_on', 'Rows are matched on {field}, so refreshing updates them instead of piling up duplicates.', null, { field: <code>{proposal.identity}</code> })
                                            : t('studio_apps_bi.sync.nothing_identifies', 'Nothing identifies a row here, so each refresh replaces the whole table.')}
                                    </p>
                                </>
                            );
                        })()}
                        {proposal.incremental?.mode && proposal.incremental.mode !== 'none' ? (
                            <p className="flex items-start gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                <Zap className="mt-0.5 h-3 w-3 shrink-0" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                                <span>
                                    <strong>{incrementalModeCopy(proposal.incremental.mode, proposal.incremental.field, proposal.incremental.param, t).title}.</strong>{' '}
                                    {incrementalModeCopy(proposal.incremental.mode, proposal.incremental.field, proposal.incremental.param, t).body}
                                </span>
                            </p>
                        ) : (
                            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {t('studio_apps_bi.sync.no_timestamp', 'Nothing here says when a record last changed, so every refresh reloads the full list.')}
                            </p>
                        )}
                        <div className="flex items-center gap-2">
                            <button type="button" onClick={accept} disabled={disabled}
                                className="rounded-md px-3 py-1.5 text-xs font-medium text-white"
                                style={{ background: 'var(--accent-primary)' }}>
                                {t('studio_apps_bi.sync.create_it', 'Create it')}
                            </button>
                            <button type="button" onClick={() => setProposal(null)} className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {t('studio_apps_bi.sync.not_now', 'Not now')}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="mt-2.5 flex items-center gap-2">
                        <button
                            type="button"
                            // Reading the columns needs the SAVED connector — so
                            // it saves, rather than going grey and leaving the
                            // user to work out that the fix is a button in
                            // another part of the window. A mailbox needs neither
                            // a saved connector nor an app id: its columns are
                            // known, so the button works the moment it exists.
                            onClick={() => (isMailbox
                                ? createMailboxTables()
                                : runWithSave({ dirty: !saved, onSave, action: inspect }))}
                            disabled={disabled || busy === 'inspect' || (!isMailbox && !appId)}
                            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                        >
                            {busy === 'inspect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Database className="h-3.5 w-3.5" aria-hidden="true" />}
                            {isMailbox ? t('studio_apps_bi.sync.set_up_table', 'Set up a table') : saveFirstLabel(t('studio_apps_bi.sync.set_up_table', 'Set up a table'), !saved, t)}
                        </button>
                        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {isMailbox
                                ? (connector.groupIntoThreads
                                    ? t('studio_apps_bi.sync.creates_threads_messages', 'Creates a conversations table and a messages table.')
                                    : t('studio_apps_bi.sync.creates_messages', 'Creates the messages table.'))
                                : t('studio_apps_bi.sync.runs_once', 'Runs the connector once and proposes the columns.')}
                        </span>
                    </div>
                )}

                {error ? (
                    <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs"
                        style={{ borderColor: 'color-mix(in srgb, var(--error) 40%, transparent)', background: 'color-mix(in srgb, var(--error) 10%, transparent)', color: 'var(--error)' }}>
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{error}</span>
                    </p>
                ) : null}
            </div>
        );
    }

    // ── Already set up ──────────────────────────────────────────────
    const incremental = sync.incremental || null;
    const cadence = sync.schedule?.everyMinutes || 60;

    return (
        <div className="rounded-lg border p-3 flex flex-col gap-2.5" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
            <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                <Database className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                {t('studio_apps_bi.sync.fills_table', 'Fills the table “{name}”', { name: table?.name || table?.key || sync.tableId })}
            </div>

            <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.sync.refresh', 'Refresh')}</span>
                    <select
                        className={INPUT}
                        value={sync.schedule?.cron ? 'cron' : String(cadence)}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.sync.refresh_schedule', 'Refresh schedule')}
                        onChange={(e) => {
                            if (e.target.value === 'cron') {
                                patchSync({ schedule: { cron: '0 6 * * *', tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam' } });
                            } else {
                                patchSync({ schedule: { everyMinutes: Number(e.target.value) } });
                            }
                        }}
                    >
                        {intervalsFor(connector?.kind, t).map((i) => <option key={i.minutes} value={String(i.minutes)}>{i.label}</option>)}
                        <option value="cron">{t('studio_apps_bi.sync.custom_schedule_option', 'On a custom schedule…')}</option>
                    </select>
                </label>
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.sync.when_rows_come_back', 'When rows come back')}</span>
                    <select
                        className={INPUT}
                        value={sync.mode === 'replace' ? 'replace' : 'upsert'}
                        disabled={disabled || !sync.keyField}
                        aria-label={t('studio_apps_bi.sync.how_rows_written', 'How rows are written')}
                        onChange={(e) => patchSync({ mode: e.target.value })}
                    >
                        <option value="upsert">{t('studio_apps_bi.sync.mode_upsert', 'Update matching rows, add the rest')}</option>
                        <option value="replace">{t('studio_apps_bi.sync.mode_replace', 'Replace everything')}</option>
                    </select>
                </label>
            </div>

            {sync.schedule?.cron ? (
                <label className="flex flex-col gap-1">
                    {/* Not "(cron)": the field below already spells out what
                        the five values mean, and the word helps nobody who
                        doesn't already know it. */}
                    <span className={LABEL}>{t('studio_apps_bi.sync.custom_schedule', 'Custom schedule')}</span>
                    <input
                        className={INPUT}
                        value={sync.schedule.cron}
                        disabled={disabled}
                        spellCheck={false}
                        placeholder="0 6 * * *"
                        onChange={(e) => patchSync({ schedule: { ...sync.schedule, cron: e.target.value } })}
                    />
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {t('studio_apps_bi.sync.cron_hint', 'Minute, hour, day of month, month, day of week — in {tz}.', { tz: sync.schedule.tz || t('studio_apps_bi.sync.your_timezone', 'your timezone') })}
                    </span>
                </label>
            ) : null}

            <label className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <input
                    type="checkbox"
                    checked={sync.refreshOnView !== false}
                    disabled={disabled}
                    onChange={(e) => patchSync({ refreshOnView: e.target.checked })}
                    className="mt-0.5 accent-[var(--accent-primary)]"
                />
                <span>
                    {t('studio_apps_bi.sync.refresh_on_view', 'Also refresh when someone opens the app and the data is older than that.')}
                    <span className="block" style={{ color: 'var(--text-tertiary)' }}>
                        {t('studio_apps_bi.sync.refresh_on_view_hint', 'Keeps an app nobody opens from spending API calls.')}
                    </span>
                </span>
            </label>

            {incremental ? (
                <label className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <input
                        type="checkbox"
                        checked
                        disabled={disabled}
                        onChange={() => patchSync({ incremental: null })}
                        className="mt-0.5 accent-[var(--accent-primary)]"
                    />
                    <span>
                        <strong>{incrementalCopy(connector, incremental, t).title}</strong>
                        <span className="block" style={{ color: 'var(--text-tertiary)' }}>
                            {incrementalCopy(connector, incremental, t).body}
                        </span>
                    </span>
                </label>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-t pt-2.5" style={{ borderColor: 'var(--border-default)' }}>
                <button
                    type="button"
                    onClick={refreshNow}
                    disabled={disabled || !appId || !saved || busy === 'sync'}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                >
                    {busy === 'sync' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                    {t('studio_apps_bi.sync.refresh_now', 'Refresh now')}
                </button>
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {/* Refresh now is the ONE action that stays gated: it writes
                        real rows from someone's mailbox into the app database,
                        and an implicit save under that is a side effect nobody
                        asked for. The wording comes from saveGate, so at least
                        the explanation is the same explanation everywhere. */}
                    {!saved
                        ? saveFirstReason(true, t)
                        : status?.lastRunAt
                            ? (status.rowsWritten
                                ? t('studio_apps_bi.sync.last_refreshed_rows', 'Last refreshed {when} — {n} rows.', { when: relative(status.lastRunAt, t), n: status.rowsWritten })
                                : t('studio_apps_bi.sync.last_refreshed', 'Last refreshed {when}.', { when: relative(status.lastRunAt, t) }))
                            // Saving seeds the schedule as due now, so the job fills
                            // it on its next tick rather than waiting a whole hour.
                            : t('studio_apps_bi.sync.scheduled', 'Scheduled — the first refresh runs within a minute.')}
                </span>
                <button
                    type="button"
                    onClick={() => onChange({ sync: undefined })}
                    disabled={disabled}
                    className="ml-auto text-xs"
                    style={{ color: 'var(--error)' }}
                >
                    {t('studio_apps_bi.sync.stop_filling', 'Stop filling this table')}
                </button>
            </div>

            {runResult ? (
                <p className="flex items-start gap-1.5 text-xs" style={{ color: '#10b981' }}>
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>
                        {runResult.alreadyRunning
                            ? t('studio_apps_bi.sync.already_running', 'A refresh was already running — it will finish shortly.')
                            : (runResult.skipped
                                ? t('studio_apps_bi.sync.done_skipped', 'Done — {inserted} added, {updated} updated, {skipped} unchanged.', { inserted: runResult.inserted, updated: runResult.updated, skipped: runResult.skipped })
                                : t('studio_apps_bi.sync.done', 'Done — {inserted} added, {updated} updated.', { inserted: runResult.inserted, updated: runResult.updated }))}
                    </span>
                </p>
            ) : null}

            {status?.lastError && !runResult ? (
                <p role="alert" className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs"
                    style={{ borderColor: 'rgba(217, 119, 6, 0.4)', background: 'rgba(217, 119, 6, 0.1)', color: '#d97706' }}>
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{t('studio_apps_bi.sync.last_failed', 'The last refresh failed: {error}', { error: status.lastError })}</span>
                </p>
            ) : null}

            {error ? (
                <p role="alert" className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs"
                    style={{ borderColor: 'color-mix(in srgb, var(--error) 40%, transparent)', background: 'color-mix(in srgb, var(--error) 10%, transparent)', color: 'var(--error)' }}>
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                </p>
            ) : null}
        </div>
    );
}
