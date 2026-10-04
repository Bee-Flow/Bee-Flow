import { AlertTriangle, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { errorKind, pillStatusOf, rowActionOf, type Column, type ErrorKind, type RowAction } from './pipelineModel';
import { StatusPill, fmt, kindLabel, statusLabel } from './stageText';
import { STAGE_DOT, useStageLabel } from './StageSwitcher';
import {
    cancelDeployment, listDeployments, retryDeployment,
    type DeploymentSummary, type PipelineRelease, type StageKey, type StageName,
} from './stagesApi';

/**
 * Every deployment this stage has had, newest first.
 *
 * Each row is the shared split pill: the status on the left and the ONE next
 * thing you can do on the right (Retry a failed deployment or a converge with
 * warnings, Cancel one that has not started). The list says "could not be read"
 * when the request failed, and "nothing yet" only after a request that
 * succeeded with no rows.
 */

export interface StageHistoryProps {
    solutionId: string;
    stage: StageKey;
    /** The caller may cancel or retry (the Solution owner). */
    canAct: boolean;
    /** Changes whenever a deployment may have moved, so the list is read again. */
    refreshKey?: number;
    onChanged?: () => void;
}

function HistoryRow({ row, what, busy, onAct }: { row: DeploymentSummary; what: RowAction; busy: boolean; onAct: (row: DeploymentSummary, what: 'retry' | 'cancel') => void }) {
    const { t } = useTranslation();
    return (
        <li className="flex items-center gap-x-3 gap-y-1 flex-wrap px-3 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-[var(--border-default)] transition-colors duration-150 motion-reduce:transition-none" data-testid="stage-history-row" data-status={row.status}>
            <StatusPill
                status={pillStatusOf(row.status)}
                label={statusLabel(t, row.status)}
                containerName={null}
                testId="stage-history-pill"
                action={what ? {
                    label: what === 'retry' ? t('solution_stages.retry', 'Retry') : t('solution_stages.cancel_request', 'Cancel'),
                    onClick: () => onAct(row, what),
                    disabled: busy,
                    primary: false,
                } : null}
            />
            <span className="text-sm text-[var(--text-primary)]">
                {kindLabel(t, row.kind)}
                {row.releaseSeq != null && <> {t('solution_stages.release_short', 'R{seq}', { seq: row.releaseSeq })}</>}
            </span>
            <span className="text-xs tabular-nums text-[var(--text-tertiary)] sm:ml-auto w-full sm:w-auto">{fmt(row.finishedAt || row.createdAt)}</span>
            {row.status === 'failed' && row.error?.message && (
                <span className="w-full text-xs text-[var(--text-secondary)]">{row.error.message}</span>
            )}
        </li>
    );
}

/** The furthest stage a release runs in (so its timeline dot wears that colour). */
function lastStage(columns: Column[], seq: number): StageName {
    const hits = columns.filter(c => c.stage !== 'dev' && c.releaseSeq === seq).map(c => c.stage);
    return hits.includes('prd') ? 'prd' : 'uat';
}

/** The releases of a Solution, newest first, with the stages each one runs in. */
export function ReleasesList({ releases, columns }: { releases: PipelineRelease[]; columns: Column[] }) {
    const { t } = useTranslation();
    const stageName = useStageLabel();
    if (releases.length === 0) {
        return (
            <p className="px-3 py-2.5 rounded-[var(--radius-md)] text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]" data-testid="pipeline-releases-empty">
                {t('solution_stages.releases_empty', 'No release has been cut yet. The first one is made when you deploy to UAT.')}
            </p>
        );
    }
    return (
        <ul className="relative space-y-3 pl-5 before:content-[''] before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-px before:bg-[var(--border-default)]" data-testid="pipeline-releases">
            {releases.map(r => {
                const where = columns.filter(c => c.stage !== 'dev' && c.releaseSeq === r.seq).map(c => stageName(c.stage));
                return (
                    <li key={r.id} className="relative flex items-center gap-x-3 gap-y-1 flex-wrap px-3 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)]" data-testid="pipeline-release-row">
                        <span className={`absolute -left-5 top-1/2 -translate-y-1/2 w-[11px] h-[11px] rounded-full ring-2 ring-[var(--bg-primary)] ${STAGE_DOT[where.length > 0 ? lastStage(columns, r.seq) : 'dev']}`} aria-hidden="true" />
                        <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{t('solution_stages.release_n', 'Release {seq}', { seq: r.seq })}</span>
                        {r.notes && (r.notes.changed || r.notes.added || r.notes.removed) ? (
                            <span className="text-xs text-[var(--text-secondary)]">
                                {t('solution_stages.notes_counts', '{changed} changed · {added} added · {removed} removed', {
                                    changed: r.notes.changed ?? 0, added: r.notes.added ?? 0, removed: r.notes.removed ?? 0,
                                })}
                            </span>
                        ) : null}
                        {r.gate?.blocked === true && (
                            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-[var(--bg-tertiary)] text-[var(--error)]">
                                {t('solution_stages.release_blocked_chip', 'Has problems')}
                            </span>
                        )}
                        {where.length > 0 && (
                            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                                {t('solution_stages.running_in', 'Running in {stages}', { stages: where.join(', ') })}
                            </span>
                        )}
                        {r.createdAt && <span className="text-xs tabular-nums text-[var(--text-tertiary)] sm:ml-auto">{new Date(r.createdAt).toLocaleString()}</span>}
                    </li>
                );
            })}
        </ul>
    );
}

export default function StageHistory({ solutionId, stage, canAct, refreshKey = 0, onChanged }: StageHistoryProps) {
    const { t } = useTranslation();
    const [rows, setRows] = useState<DeploymentSummary[] | null>(null);
    const [cursor, setCursor] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [problem, setProblem] = useState<ErrorKind | null>(null);

    const load = useCallback(async (after: string | null) => {
        const res = await listDeployments(solutionId, stage, after);
        if (!res.ok || !Array.isArray(res.data?.deployments)) { setFailed(true); return; }
        setFailed(false);
        setCursor(res.data.nextCursor || null);
        setRows(prev => (after && prev ? [...prev, ...res.data.deployments] : res.data.deployments));
    }, [solutionId, stage]);

    useEffect(() => { load(null); }, [load, refreshKey]);

    const act = async (row: DeploymentSummary, what: 'retry' | 'cancel') => {
        setBusyId(row.id);
        setProblem(null);
        const res = what === 'retry' ? await retryDeployment(solutionId, row.id) : await cancelDeployment(solutionId, row.id);
        setBusyId(null);
        if (!res.ok) { setProblem(errorKind(res)); return; }
        await load(null);
        onChanged?.();
    };

    if (failed && !rows) {
        return (
            <p className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)]" data-testid="stage-history-unreadable">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--warning)]" aria-hidden="true" />
                {t('solution_stages.history_unreadable', 'The history of this stage could not be read, so this is not "nothing happened here".')}
            </p>
        );
    }
    if (!rows) {
        return (
            <div className="flex justify-center py-10 text-[var(--text-tertiary)]">
                <Loader2 className="w-5 h-5 animate-spin" aria-label={t('solution_stages.loading', 'Loading…')} />
            </div>
        );
    }
    if (rows.length === 0) {
        return (
            <p className="px-3 py-2.5 rounded-[var(--radius-md)] text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]" data-testid="stage-history-empty">
                {t('solution_stages.history_empty', 'Nothing has been deployed to this stage yet.')}
            </p>
        );
    }
    return (
        <div className="space-y-2" data-testid="stage-history">
            {problem && (
                <p className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)]" role="alert" data-testid="stage-history-problem">
                    {problem === 'stage_busy'
                        ? t('solution_stages.err_stage_busy', 'Another deployment is running in this stage. Wait for it to finish.')
                        : t('solution_stages.history_action_failed', 'That could not be done just now.')}
                </p>
            )}
            <ul className="space-y-1.5">
                {rows.map(row => (
                    <HistoryRow key={row.id} row={row} what={canAct ? rowActionOf(row) : null} busy={busyId === row.id} onAct={act} />
                ))}
            </ul>
            {cursor && (
                <button
                    type="button"
                    onClick={() => load(cursor)}
                    className="min-h-10 px-3 rounded-[var(--radius-sm)] text-xs border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                >
                    {t('solution_stages.load_more', 'Show older')}
                </button>
            )}
        </div>
    );
}
