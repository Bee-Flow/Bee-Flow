/**
 * The sync panel before a table is set up: the pitch, the "Set up a table"
 * button, and the table /inspect proposes for the owner to confirm.
 */
import { AlertTriangle, CornerDownRight, Database, Loader2, Table2, Zap } from 'lucide-react';
import { incrementalModeCopy } from './syncModel';
import type { ProposedSetTable, SyncProposal } from './syncModel';
import type { SyncActions, SyncConnector } from './useSyncActions';
import useTranslation from '../../../../../../hooks/useTranslation';
import { runWithSave as runWithSaveJs, saveFirstLabel } from '../saveGate';
import { tRich as tRichJs } from '../tRich';

// Aliases that keep the compiled text of the two helper imports.
const tRich = tRichJs;
const runWithSave = runWithSaveJs;

/** A red alert line under the panel. */
export function SyncError({ error, className = '' }: { error: string; className?: string }) {
    return (
        <p role="alert" className={`${className}flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs`}
            style={{ borderColor: 'color-mix(in srgb, var(--error) 40%, transparent)', background: 'color-mix(in srgb, var(--error) 10%, transparent)', color: 'var(--error)' }}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
        </p>
    );
}

/**
 * A chain whose steps returned different things ("messages", their content,
 * "attachments") gets one linked table each, rather than one wide table that
 * repeats every message once per attachment.
 */
function TableSetProposal({ set }: { set: ProposedSetTable[] }) {
    const { t } = useTranslation();
    return (
        <>
            <p className="text-xs text-[var(--text-primary)]">
                {t('studio_apps_bi.sync.steps_return', 'Your steps return {n} different things, so they get {n} linked tables:', { n: set.length })}
            </p>
            {set.map((tb, i) => (
                <div key={tb.table.id} className="flex flex-col gap-0.5" style={{ paddingLeft: i ? '1rem' : 0 }}>
                    <div className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
                        {i ? <CornerDownRight className="h-3.5 w-3.5" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                            : <Table2 className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />}
                        {tb.table.name}
                        <span className="text-xs text-[var(--text-tertiary)]">
                            {tb.rowCount === 1
                                ? t('studio_apps_bi.sync.table_summary_one', '— {cols} columns, 1 row', { cols: tb.table.fields.length })
                                : t('studio_apps_bi.sync.table_summary_many', '— {cols} columns, {rows} rows', { cols: tb.table.fields.length, rows: tb.rowCount })}
                        </span>
                    </div>
                    <p className="text-xs text-[var(--text-tertiary)]">
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
            <p className="text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_bi.sync.link_auto', 'The link is filled in automatically each refresh — you don’t have to match them up.')}
            </p>
        </>
    );
}

function SingleTableProposal({ proposal }: { proposal: SyncProposal }) {
    const { t } = useTranslation();
    return (
        <>
            <p className="text-xs text-[var(--text-primary)]">
                {proposal.rowCount === 1
                    ? t('studio_apps_bi.sync.got_one_row', 'Got 1 row back. Here’s the table that fits:')
                    : t('studio_apps_bi.sync.got_rows', 'Got {n} rows back. Here’s the table that fits:', { n: proposal.rowCount })}
            </p>
            <div className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
                <Table2 className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                {proposal.suggestedTable.name}
                <span className="text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_bi.sync.columns_summary', '— {cols} columns', { cols: proposal.suggestedTable.fields.length })}
                </span>
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">
                {proposal.suggestedTable.fields.slice(0, 8).map((f) => f.key).join(', ')}
                {proposal.suggestedTable.fields.length > 8 ? '…' : ''}
            </p>
            <p className="text-xs text-[var(--text-tertiary)]">
                {proposal.identity
                    ? tRich(t, 'studio_apps_bi.sync.rows_matched_on', 'Rows are matched on {field}, so refreshing updates them instead of piling up duplicates.', null, { field: <code>{proposal.identity}</code> })
                    : t('studio_apps_bi.sync.nothing_identifies', 'Nothing identifies a row here, so each refresh replaces the whole table.')}
            </p>
        </>
    );
}

/** The table /inspect proposes, how it loads, and Create it / Not now. */
function ProposalCard({ proposal, actions, disabled }: { proposal: SyncProposal; actions: SyncActions; disabled?: boolean }) {
    const { t } = useTranslation();
    const set = proposal.tableSet?.tables;
    const inc = proposal.incremental;
    const copy = inc?.mode && inc.mode !== 'none' ? incrementalModeCopy(inc.mode, inc.field, inc.param, t) : null;
    return (
        <div className="mt-2.5 flex flex-col gap-2 rounded-md border p-2.5 border-[var(--border-default)] bg-[var(--bg-tertiary)]">
            {set && set.length > 1 ? <TableSetProposal set={set} /> : <SingleTableProposal proposal={proposal} />}
            {copy ? (
                <p className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
                    <Zap className="mt-0.5 h-3 w-3 shrink-0" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                    <span>
                        <strong>{copy.title}.</strong>{' '}
                        {copy.body}
                    </span>
                </p>
            ) : (
                <p className="text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_bi.sync.no_timestamp', 'Nothing here says when a record last changed, so every refresh reloads the full list.')}
                </p>
            )}
            <div className="flex items-center gap-2">
                <button type="button" onClick={actions.accept} disabled={disabled}
                    className="rounded-md px-3 py-1.5 text-xs font-medium text-white bg-[var(--accent-primary)]">
                    {t('studio_apps_bi.sync.create_it', 'Create it')}
                </button>
                <button type="button" onClick={() => actions.setProposal(null)} className="text-xs text-[var(--text-secondary)]">
                    {t('studio_apps_bi.sync.not_now', 'Not now')}
                </button>
            </div>
        </div>
    );
}

interface SyncSetupProps {
    connector: SyncConnector;
    actions: SyncActions;
    appId: string | null;
    disabled?: boolean;
    saved?: boolean;
    onSave?: (() => unknown) | null;
}

export default function SyncSetup({ connector, actions, appId, disabled, saved, onSave }: SyncSetupProps) {
    const { t } = useTranslation();
    const isMailbox = connector.kind === 'mailbox';
    const { proposal, busy, error } = actions;
    return (
        <div className="rounded-lg border p-3 border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)]">
                <Database className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                {t('studio_apps_bi.sync.keep_in_table', 'Keep this in a table')}
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_bi.sync.keep_intro', 'Store what this connector returns in one of your app’s tables. The app then reads the table instead of calling {app} on every screen — faster for viewers, and far fewer API calls.', { app: connector.integrationId || t('studio_apps_bi.sync.the_app', 'the app') })}
            </p>

            {proposal ? <ProposalCard proposal={proposal} actions={actions} disabled={disabled} /> : (
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
                            ? actions.createMailboxTables()
                            : runWithSave({ dirty: !saved, onSave, action: actions.inspect }))}
                        disabled={disabled || busy === 'inspect' || (!isMailbox && !appId)}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-primary)]"
                    >
                        {busy === 'inspect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Database className="h-3.5 w-3.5" aria-hidden="true" />}
                        {isMailbox ? t('studio_apps_bi.sync.set_up_table', 'Set up a table') : saveFirstLabel(t('studio_apps_bi.sync.set_up_table', 'Set up a table'), !saved, t)}
                    </button>
                    <span className="text-xs text-[var(--text-tertiary)]">
                        {isMailbox
                            ? (connector.groupIntoThreads
                                ? t('studio_apps_bi.sync.creates_threads_messages', 'Creates a conversations table and a messages table.')
                                : t('studio_apps_bi.sync.creates_messages', 'Creates the messages table.'))
                            : t('studio_apps_bi.sync.runs_once', 'Runs the connector once and proposes the columns.')}
                    </span>
                </div>
            )}

            {error ? <SyncError error={error} className="mt-2 " /> : null}
        </div>
    );
}
