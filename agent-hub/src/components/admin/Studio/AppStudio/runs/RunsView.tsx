import React, { useMemo, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import type { RunActors, RunFilters, RunPage, RunSummary, RunsApi } from './runsApi';
import { runsApi, useRunList } from './runsApi';
import RunDetail from './RunDetail';
import { PEOPLE_ORIGINS, TONE_CLASS, actorText, formatCost, formatDuration, originText, statusText, statusTone } from './runsModel';

const STATUSES = ['success', 'error', 'running', 'paused', 'interrupted', 'cancelled'];
const selectCls = 'rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]';
const thCls = 'py-1 pr-3 font-normal';
const tdCls = 'py-1.5 pr-3 text-[var(--text-secondary)]';

type FilterState = { actionId: string; status: string; user: string; withTests: boolean };

/**
 * The Runs overview of an app (inside the Logic view): every logged action run, newest first,
 * filtered by action, status and who ran it; tests and MCP runs only with the toggle. A run opens
 * its steps (RunDetail). The api is injectable (tests).
 */
export default function RunsView({ appId, actionIds, api = runsApi, onOpenLogic }: {
    appId: string; actionIds: string[]; api?: RunsApi; onOpenLogic?: (actionId: string) => void;
}) {
    const { t } = useTranslation();
    const [f, setF] = useState<FilterState>({ actionId: '', status: '', user: '', withTests: false });
    const [openRun, setOpenRun] = useState<string | null>(null);
    const filters: RunFilters = useMemo(() => ({
        ...(f.actionId ? { actionId: f.actionId } : {}), ...(f.status ? { status: f.status } : {}), ...(f.user ? { user: f.user } : {}),
        ...(f.withTests ? {} : { origin: PEOPLE_ORIGINS }),
    }), [f]);
    const q = useRunList(api, appId, filters);

    if (openRun) return <RunDetail api={api} appId={appId} runId={openRun} onBack={() => setOpenRun(null)} onOpenLogic={onOpenLogic} />;

    const pages: RunPage[] = q.data?.pages ?? [];
    const runs = pages.flatMap((p) => p.runs);
    const first = pages[0];
    return (
        <div className="flex flex-col gap-3 p-4 text-sm" data-testid="runs-view">
            <RunFiltersRow value={f} onChange={setF} actionIds={actionIds} actors={first?.actors} />
            {q.isLoading ? <p className="text-[var(--text-secondary)]">{t('studio_apps_runs.loading', 'Loading runs…')}</p> : null}
            {q.isError ? <p className="text-[var(--error)]" role="alert">{t('studio_apps_runs.load_failed', 'The runs could not be loaded.')}</p> : null}
            {!q.isLoading && !q.isError && !runs.length ? (
                <p className="text-[var(--text-tertiary)]" data-testid="runs-empty">{t('studio_apps_runs.empty', 'No runs yet. A run appears here as soon as someone uses an action that does work on the server.')}</p>
            ) : null}
            {runs.length ? <RunsTable runs={runs} onOpen={setOpenRun} /> : null}
            {q.hasNextPage ? (
                <button type="button" className="self-start text-[var(--accent-primary)]" disabled={q.isFetchingNextPage} onClick={() => { void q.fetchNextPage(); }}>
                    {t('studio_apps_runs.load_more', 'Show older runs')}
                </button>
            ) : null}
            {first ? <RetentionNote days={first.retentionDays} /> : null}
        </div>
    );
}

function RunFiltersRow({ value, onChange, actionIds, actors }: {
    value: FilterState; onChange: (next: FilterState) => void; actionIds: string[]; actors: RunActors | undefined;
}) {
    const { t } = useTranslation();
    const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });
    return (
        <div className="flex flex-wrap items-center gap-2">
            <select className={selectCls} value={value.actionId} onChange={(e) => set({ actionId: e.target.value })} aria-label={t('studio_apps_runs.filter.action', 'Action')}>
                <option value="">{t('studio_apps_runs.filter.all_actions', 'All actions')}</option>
                {actionIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <select className={selectCls} value={value.status} onChange={(e) => set({ status: e.target.value })} aria-label={t('studio_apps_runs.filter.status', 'Status')}>
                <option value="">{t('studio_apps_runs.filter.all_statuses', 'Every status')}</option>
                {STATUSES.map((s) => <option key={s} value={s}>{statusText(s, t)}</option>)}
            </select>
            <select className={selectCls} value={value.user} onChange={(e) => set({ user: e.target.value })} aria-label={t('studio_apps_runs.filter.user', 'Who')}>
                <option value="">{t('studio_apps_runs.filter.everyone', 'Everyone')}</option>
                <option value="me">{t('studio_apps_runs.actor.you', 'You')}</option>
                {(actors?.users ?? []).filter((u) => u.name).map((u) => <option key={u.userId} value={u.userId}>{u.name}</option>)}
                {actors?.visitors ? <option value="visitors">{t('studio_apps_runs.actor.visitor', 'Public visitor')}</option> : null}
                {actors?.system ? <option value="system">{t('studio_apps_runs.actor.system', 'System (mailbox)')}</option> : null}
            </select>
            <label className="flex items-center gap-1 text-[var(--text-secondary)]">
                <input type="checkbox" checked={value.withTests} onChange={(e) => set({ withTests: e.target.checked })} />
                {t('studio_apps_runs.filter.with_tests', 'Include tests and MCP runs')}
            </label>
        </div>
    );
}

function RunsTable({ runs, onOpen }: { runs: RunSummary[]; onOpen: (runId: string) => void }) {
    const { t } = useTranslation();
    return (
        <table className="w-full border-collapse text-left">
            <thead className="text-xs text-[var(--text-tertiary)]">
                <tr>
                    <th className={thCls}>{t('studio_apps_runs.col.when', 'When')}</th>
                    <th className={thCls}>{t('studio_apps_runs.col.action', 'Action')}</th>
                    <th className={thCls}>{t('studio_apps_runs.col.who', 'Who')}</th>
                    <th className={thCls}>{t('studio_apps_runs.col.status', 'Status')}</th>
                    <th className={thCls}>{t('studio_apps_runs.col.duration', 'Duration')}</th>
                    <th className={thCls}>{t('studio_apps_runs.col.steps', 'Steps')}</th>
                    <th className={thCls}>{t('studio_apps_runs.col.ai_cost', 'AI cost')}</th>
                </tr>
            </thead>
            <tbody>
                {runs.map((r) => <RunRow key={r.id} run={r} onOpen={onOpen} />)}
            </tbody>
        </table>
    );
}

function RunRow({ run: r, onOpen }: { run: RunSummary; onOpen: (runId: string) => void }) {
    const { t, locale } = useTranslation();
    return (
        <tr className="border-t border-[var(--border-subtle)] hover:bg-[var(--bg-card-hover)]" data-testid="run-row">
            <td className={tdCls}>{r.startedAt ? new Date(r.startedAt).toLocaleString(locale) : '—'}</td>
            <td className="py-1.5 pr-3">
                <button type="button" className="text-left text-[var(--accent-primary)]" onClick={() => onOpen(r.id)}>{r.actionId}</button>
            </td>
            <td className={tdCls}>{actorText(r.actor, t)} · {originText(r.origin, t)}</td>
            <td className={`py-1.5 pr-3 ${TONE_CLASS[statusTone(r.status)]}`} title={r.error ?? undefined}>
                {statusText(r.status, t)}
                {r.error ? <span className="block max-w-xs truncate text-xs text-[var(--error)]">{r.error}</span> : null}
            </td>
            <td className={tdCls}>{formatDuration(r.durationMs)}</td>
            <td className={tdCls}>{r.stepCount}{r.failedSteps ? ` · ${t('studio_apps_runs.failed_count', '{n} failed', { n: r.failedSteps })}` : ''}</td>
            <td className={tdCls}>{formatCost(r.ai.costByCurrency, locale)}</td>
        </tr>
    );
}

function RetentionNote({ days }: { days: number }) {
    const { t } = useTranslation();
    return (
        <p className="text-xs text-[var(--text-tertiary)]" data-testid="runs-retention">
            {days
                ? t('studio_apps_runs.retention', 'Runs are kept for {days} days. Only what ran, how long it took and how it ended is logged, never the data.', { days })
                : t('studio_apps_runs.retention_forever', 'Runs are kept until the app is deleted. Only what ran, how long it took and how it ended is logged, never the data.')}
        </p>
    );
}
