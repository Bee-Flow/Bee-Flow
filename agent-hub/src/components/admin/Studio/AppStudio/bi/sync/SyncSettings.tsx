/**
 * The sync panel once a table is set up: the schedule, how rows are written,
 * refresh-on-view, incremental loading, and the last run.
 */
import { AlertTriangle, CheckCircle2, Database, Loader2, RefreshCw } from 'lucide-react';
import { INPUT, LABEL, incrementalCopy, intervalsFor, relative } from './syncModel';
import type { Incremental, SyncBlock } from './syncModel';
import { SyncError } from './SyncSetup';
import type { RunResult, SyncActions, SyncConnector, SyncStatus } from './useSyncActions';
import useTranslation from '@/hooks/useTranslation';
import { saveFirstReason } from '../saveGate';

type PatchSync = (patch: Partial<SyncBlock>) => void;

/** Refresh cadence (or a custom cron) and how rows are written. */
function ScheduleFields({ connector, sync, patchSync, disabled }: { connector: SyncConnector; sync: SyncBlock; patchSync: PatchSync; disabled?: boolean }) {
    const { t } = useTranslation();
    const cadence = sync.schedule?.everyMinutes || 60;
    return (
        <>
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
                    <span className="text-xs text-[var(--text-tertiary)]">
                        {t('studio_apps_bi.sync.cron_hint', 'Minute, hour, day of month, month, day of week — in {tz}.', { tz: sync.schedule.tz || t('studio_apps_bi.sync.your_timezone', 'your timezone') })}
                    </span>
                </label>
            ) : null}
        </>
    );
}

/** Refresh-on-view and (when the data allows it) incremental loading. */
function LoadingOptions({ connector, sync, patchSync, disabled }: { connector: SyncConnector; sync: SyncBlock; patchSync: PatchSync; disabled?: boolean }) {
    const { t } = useTranslation();
    const incremental: Incremental | null = sync.incremental || null;
    const copy = incremental ? incrementalCopy(connector?.kind, incremental, t) : null;
    return (
        <>
            <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                <input
                    type="checkbox"
                    checked={sync.refreshOnView !== false}
                    disabled={disabled}
                    onChange={(e) => patchSync({ refreshOnView: e.target.checked })}
                    className="mt-0.5 accent-[var(--accent-primary)]"
                />
                <span>
                    {t('studio_apps_bi.sync.refresh_on_view', 'Also refresh when someone opens the app and the data is older than that.')}
                    <span className="block text-[var(--text-tertiary)]">
                        {t('studio_apps_bi.sync.refresh_on_view_hint', 'Keeps an app nobody opens from spending API calls.')}
                    </span>
                </span>
            </label>

            {copy ? (
                <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                    <input
                        type="checkbox"
                        checked
                        disabled={disabled}
                        onChange={() => patchSync({ incremental: null })}
                        className="mt-0.5 accent-[var(--accent-primary)]"
                    />
                    <span>
                        <strong>{copy.title}</strong>
                        <span className="block text-[var(--text-tertiary)]">
                            {copy.body}
                        </span>
                    </span>
                </label>
            ) : null}
        </>
    );
}

/** What the last run (or the one just triggered) did. */
function lastRunText(saved: boolean | undefined, status: SyncStatus | null, t: ReturnType<typeof useTranslation>['t']): string {
    if (!saved) return saveFirstReason(true, t);
    if (!status?.lastRunAt) {
        // Saving seeds the schedule as due now, so the job fills it on its
        // next tick rather than waiting a whole hour.
        return t('studio_apps_bi.sync.scheduled', 'Scheduled — the first refresh runs within a minute.');
    }
    return status.rowsWritten
        ? t('studio_apps_bi.sync.last_refreshed_rows', 'Last refreshed {when} — {n} rows.', { when: relative(status.lastRunAt, t), n: status.rowsWritten })
        : t('studio_apps_bi.sync.last_refreshed', 'Last refreshed {when}.', { when: relative(status.lastRunAt, t) });
}

function RunOutcome({ runResult }: { runResult: RunResult }) {
    const { t } = useTranslation();
    return (
        <p className="flex items-start gap-1.5 text-xs [color:#10b981]!">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
                {runResult.alreadyRunning
                    ? t('studio_apps_bi.sync.already_running', 'A refresh was already running — it will finish shortly.')
                    : (runResult.skipped
                        ? t('studio_apps_bi.sync.done_skipped', 'Done — {inserted} added, {updated} updated, {skipped} unchanged.', { inserted: runResult.inserted, updated: runResult.updated, skipped: runResult.skipped })
                        : t('studio_apps_bi.sync.done', 'Done — {inserted} added, {updated} updated.', { inserted: runResult.inserted, updated: runResult.updated }))}
            </span>
        </p>
    );
}

interface SyncSettingsProps {
    connector: SyncConnector;
    sync: SyncBlock;
    tableName: string | undefined;
    actions: SyncActions;
    appId: string | null;
    disabled?: boolean;
    saved?: boolean;
    onChange: (patch: Record<string, unknown>) => void;
}

export default function SyncSettings({ connector, sync, tableName, actions, appId, disabled, saved, onChange }: SyncSettingsProps) {
    const { t } = useTranslation();
    const { busy, status, runResult, error, refreshNow } = actions;
    const patchSync: PatchSync = (patch) => onChange({ sync: { ...sync, ...patch } });
    return (
        <div className="rounded-lg border p-3 flex flex-col gap-2.5 border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)]">
                <Database className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
                {t('studio_apps_bi.sync.fills_table', 'Fills the table “{name}”', { name: tableName })}
            </div>

            <ScheduleFields connector={connector} sync={sync} patchSync={patchSync} disabled={disabled} />
            <LoadingOptions connector={connector} sync={sync} patchSync={patchSync} disabled={disabled} />

            <div className="flex flex-wrap items-center gap-2 border-t pt-2.5 border-[var(--border-default)]">
                <button
                    type="button"
                    onClick={refreshNow}
                    disabled={disabled || !appId || !saved || busy === 'sync'}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-primary)]"
                >
                    {busy === 'sync' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                    {t('studio_apps_bi.sync.refresh_now', 'Refresh now')}
                </button>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {/* Refresh now is the ONE action that stays gated: it writes
                        real rows from someone's mailbox into the app database,
                        and an implicit save under that is a side effect nobody
                        asked for. The wording comes from saveGate, so at least
                        the explanation is the same explanation everywhere. */}
                    {lastRunText(saved, status, t)}
                </span>
                <button
                    type="button"
                    onClick={() => onChange({ sync: undefined })}
                    disabled={disabled}
                    className="ml-auto text-xs text-[var(--error)]"
                >
                    {t('studio_apps_bi.sync.stop_filling', 'Stop filling this table')}
                </button>
            </div>

            {runResult ? <RunOutcome runResult={runResult} /> : null}

            {status?.lastError && !runResult ? (
                <p role="alert" className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs [border-color:rgba(217,119,6,0.4)] [background:rgba(217,119,6,0.1)] [color:#d97706]!">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{t('studio_apps_bi.sync.last_failed', 'The last refresh failed: {error}', { error: status.lastError })}</span>
                </p>
            ) : null}

            {error ? <SyncError error={error} /> : null}
        </div>
    );
}
