import { AlertTriangle, ArrowDown, ArrowRight, Loader2 } from 'lucide-react';
import React, { useEffect } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DeployDialog from './DeployDialog';
import { actionLabel, usePipelineActions, type T } from './pipelineActions';
import {
    buildColumns, type Column, type ColumnAction, type PipelineReadState,
} from './pipelineModel';
import { STAGE_ICON, STAGE_INK, STAGE_RULE, STAGE_TINT, useStageLabel } from './StageSwitcher';
import { ReleasesList } from './StageHistory';
import { errorText, findingText, statusLabel } from './StageStatus';
import type { Pipeline, StageKey } from './stagesApi';

/**
 * The Pipeline tab of a Dev Solution: three columns (Dev, UAT, Production), the
 * ONE thing each can do next, and the releases that got them there.
 *
 * Everything that decides lives in pipelineModel.ts; this file is words and
 * buttons. The pipeline arrives as a prop (SolutionDetail reads it once for the
 * switcher too) and `onReload` asks for it again after anything that may have
 * moved a stage. A pipeline that could not be read says so — it never falls
 * through to the "Set up stages" empty state, which is reachable only from a
 * successful read that listed no stage.
 */

export interface PipelineTabProps {
    solutionId: string;
    solutionName: string;
    /** null = not read (yet, or at all); readState says which. */
    pipeline: Pipeline | null;
    readState: PipelineReadState;
    /** The caller owns the Solution: only they get actions (design 8: SO). */
    owner: boolean;
    onReload: () => void;
    onOpenSettings?: (stage: StageKey) => void;
    onOpenChecks?: () => void;
    /** How often a running deployment re-reads the pipeline. */
    pollMs?: number;
}

function stateText(t: T, col: Column, stageName: (s: 'dev' | StageKey) => string): string {
    const stage = col.stage === 'dev' ? 'uat' : col.stage;
    const texts: Record<Column['state'], string> = {
        no_stages: t('solution_stages.state_no_stages', 'This Solution has no stages yet.'),
        blocked: t('solution_stages.state_blocked', '{count} to fix before a release can be cut.', { count: col.blockedCount ?? 0 }),
        no_release: t('solution_stages.state_no_release', 'No release has been cut yet.'),
        ahead: t('solution_stages.state_ahead', 'Ahead of the last release: {changed} changed · {added} added · {removed} removed.', {
            changed: col.ahead?.changed ?? 0, added: col.ahead?.added ?? 0, removed: col.ahead?.removed ?? 0,
        }),
        in_sync: t('solution_stages.state_in_sync', 'Nothing new since the last release.'),
        not_set_up: t('solution_stages.state_not_set_up', 'Not set up.'),
        waiting: col.stage === 'prd'
            ? t('solution_stages.state_waiting_prd', 'Waiting for a release that succeeded in UAT.')
            : t('solution_stages.state_waiting_uat', 'Waiting for a release without problems.'),
        empty: t('solution_stages.state_empty', 'Nothing deployed to {stage} yet.', { stage: stageName(stage) }),
        behind: t('solution_stages.state_behind', 'A newer release is ready.'),
        promote: t('solution_stages.state_promote', 'UAT runs a newer release than Production.'),
        current: t('solution_stages.state_current', 'Up to date.'),
        running: t('solution_stages.state_running', 'A deployment is running.'),
        awaiting_approval: t('solution_stages.state_awaiting_approval', 'Waiting for approval. Nothing has changed yet.'),
    };
    return texts[col.state];
}

/** What went wrong or half-way with the last deployment, in a line each. */
function ColumnNotes({ col }: { col: Column }) {
    const { t } = useTranslation();
    const stageName = useStageLabel();
    return (
        <>
            {col.state === 'running' && col.lastDeployment && (
                <p className="flex items-center gap-2 text-sm text-[var(--text-primary)]" data-testid="pipeline-progress">
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    {statusLabel(t, col.lastDeployment.status)}
                </p>
            )}
            {col.attention === 'failed' && (
                <p className="flex items-start gap-2 px-2.5 py-2 rounded-[var(--radius-sm)] text-[13px] text-[var(--text-primary)] border-l-2 border-l-[var(--error)] bg-[var(--bg-secondary)]" role="alert" data-testid="pipeline-failed">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--error)]" aria-hidden="true" />
                    {t('solution_stages.last_failed', 'The last deployment failed. Nothing changed in {stage}.', { stage: stageName(col.stage) })}
                </p>
            )}
            {col.attention === 'warnings' && (
                <p className="flex items-start gap-2 px-2.5 py-2 rounded-[var(--radius-sm)] text-[13px] text-[var(--text-primary)] border-l-2 border-l-[var(--warning)] bg-[var(--bg-secondary)]" data-testid="pipeline-warnings">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
                    {t('solution_stages.last_warnings', 'It is live, but some follow-up steps did not finish.')}
                </p>
            )}
            {col.bindingsPending && col.stage !== 'dev' && (
                <p className="text-[12px] text-[var(--text-secondary)]" data-testid="pipeline-settings-pending">
                    {t('solution_stages.settings_pending_short', 'Settings changed since the last deploy.')}
                </p>
            )}
        </>
    );
}

function StageIcon({ stage }: { stage: 'dev' | StageKey }) {
    const Icon = STAGE_ICON[stage];
    return <Icon className="w-4 h-4" />;
}

const BTN = 'inline-flex items-center justify-center gap-1.5 min-h-10 px-3 rounded-[var(--radius-sm)] text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-card)] disabled:opacity-50 disabled:cursor-not-allowed';
const BTN_PRIMARY = `${BTN} font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]`;
const BTN_SECONDARY = `${BTN} border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)]`;

function ColumnCard({ col, busy, onAct, onOpenChecks, onOpenSettings }: {
    col: Column; busy: boolean;
    onAct: (a: ColumnAction, col: Column) => void;
    onOpenChecks?: () => void;
    onOpenSettings?: (stage: StageKey) => void;
}) {
    const { t } = useTranslation();
    const stageName = useStageLabel();
    return (
        <section
            className={`flex flex-col gap-3 h-full rounded-[var(--radius-lg)] border border-t-2 border-[var(--border-subtle)] p-4 lg:p-5 bg-[var(--bg-card)] transition-colors duration-150 motion-reduce:transition-none hover:border-[var(--border-default)] ${STAGE_RULE[col.stage]}`}
            aria-labelledby={`pipeline-col-title-${col.stage}`}
            data-testid={`pipeline-column-${col.stage}`}
            data-state={col.state}
        >
            <header className="flex items-center gap-2">
                <span className={`inline-flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] ${STAGE_TINT[col.stage]} ${STAGE_INK[col.stage]}`} aria-hidden="true">
                    <StageIcon stage={col.stage} />
                </span>
                <h3 id={`pipeline-col-title-${col.stage}`} className={`text-[15px] font-semibold ${STAGE_INK[col.stage]}`}>{stageName(col.stage)}</h3>
                {col.stage !== 'dev' && col.releaseSeq !== null && (
                    <span className="ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" data-testid={`pipeline-release-${col.stage}`}>
                        {t('solution_stages.release_short', 'R{seq}', { seq: col.releaseSeq })}
                    </span>
                )}
            </header>

            <p className="text-[13px] text-[var(--text-secondary)]" data-testid={`pipeline-state-${col.stage}`}>{stateText(t, col, stageName)}</p>

            <ColumnNotes col={col} />

            <div className="mt-auto flex flex-wrap items-center gap-2">
                {col.primary && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => col.primary && onAct(col.primary, col)}
                        data-testid={`pipeline-primary-${col.stage}`}
                        className={BTN_PRIMARY}
                    >
                        {actionLabel(t, col.primary, stageName)}
                        <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                )}
                {col.secondary.map(a => (
                    <button
                        key={`${a.id}:${a.releaseSeq ?? ''}`}
                        type="button"
                        disabled={busy}
                        onClick={() => onAct(a, col)}
                        data-testid={`pipeline-secondary-${a.id}`}
                        className={BTN_SECONDARY}
                    >
                        {actionLabel(t, a, stageName)}
                    </button>
                ))}
                {col.state === 'blocked' && onOpenChecks && (
                    <button
                        type="button"
                        onClick={onOpenChecks}
                        data-testid="pipeline-open-checks"
                        className={BTN_SECONDARY}
                    >
                        {t('solution_stages.open_checks', 'Open the checks')}
                    </button>
                )}
                {col.stage !== 'dev' && col.bindingsPending && onOpenSettings && (
                    <button
                        type="button"
                        onClick={() => onOpenSettings(col.stage as StageKey)}
                        className={`${BTN} text-[var(--text-secondary)] underline`}
                    >
                        {t('solution_stages.open_settings', 'Stage settings')}
                    </button>
                )}
            </div>
        </section>
    );
}

function ReadProblem({ state }: { state: PipelineReadState }) {
    const { t } = useTranslation();
    const text = state === 'no_licence'
        ? t('solution_stages.read_no_licence', 'Your plan does not include release pipelines, so stages are not available here.')
        : state === 'forbidden'
            ? t('solution_stages.read_forbidden', 'You do not have access to the pipeline of this Solution.')
            : state === 'not_a_solution'
                ? t('solution_stages.read_not_a_solution', 'Only a Solution can have stages.')
                : t('solution_stages.read_unreadable', 'The pipeline could not be read, so this is not "no stages". Try again shortly.');
    return (
        <p className="flex items-start gap-2 px-3 py-2.5 rounded-[var(--radius-md)] text-sm border-l-2 border-l-[var(--warning)] bg-[var(--bg-secondary)] text-[var(--text-primary)]" role="status" data-testid="pipeline-read-problem" data-state={state}>
            <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--warning)]" aria-hidden="true" />
            {text}
        </p>
    );
}

function EmptyStages({ owner, busy, onSetup }: { owner: boolean; busy: boolean; onSetup: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-5 bg-[var(--bg-card)] space-y-3" data-testid="pipeline-empty">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('solution_stages.empty_title', 'Test before it goes live')}</h3>
            <p className="text-sm text-[var(--text-secondary)]">
                {t('solution_stages.empty_body', 'Stages give this Solution a UAT copy to test in and a Production copy people rely on. Both are locked: you change things in Dev and deploy a release.')}
            </p>
            {owner ? (
                <button
                    type="button"
                    disabled={busy}
                    onClick={onSetup}
                    data-testid="pipeline-setup"
                    className={BTN_PRIMARY}
                >
                    {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                    {t('solution_stages.action_setup', 'Set up stages')}
                </button>
            ) : (
                <p className="text-xs text-[var(--text-tertiary)]">{t('solution_stages.empty_owner_only', 'Only the owner of this Solution can set up stages.')}</p>
            )}
        </div>
    );
}

export default function PipelineTab({
    solutionId, solutionName, pipeline, readState, owner, onReload, onOpenSettings, onOpenChecks, pollMs = 4000,
}: PipelineTabProps) {
    const { t } = useTranslation();
    const { dialog, setDialog, busy, problem, findings, act } = usePipelineActions(solutionId, onReload);
    const columns = pipeline ? buildColumns(pipeline, { owner }) : [];
    const anyRunning = columns.some(c => c.state === 'running');

    // A deployment that runs while the tab is open (started here, by a
    // colleague, or by the runner after an approval) moves the columns.
    useEffect(() => {
        if (!anyRunning) return undefined;
        const id = setInterval(onReload, pollMs);
        return () => clearInterval(id);
    }, [anyRunning, onReload, pollMs]);

    if (readState !== 'ok' || !pipeline) return <ReadProblem state={readState === 'ok' ? 'unreadable' : readState} />;

    const hasStages = pipeline.stages.length > 0;

    return (
        <div className="space-y-6" data-testid="pipeline-tab">
            {!hasStages && pipeline.dev && <EmptyStages owner={owner} busy={busy} onSetup={() => act({ id: 'setup' })} />}

            {problem && (
                <div className="px-3 py-2.5 rounded-[var(--radius-md)] text-sm border-l-2 border-l-[var(--error)] bg-[var(--bg-secondary)] text-[var(--text-primary)] space-y-1.5" role="alert" data-testid="pipeline-problem" data-kind={problem}>
                    <p>{errorText(t, problem)}</p>
                    {findings.length > 0 && (
                        <ul className="list-disc pl-5 text-xs text-[var(--text-secondary)]">
                            {findings.map((f, i) => <li key={`${f.code}:${f.ref ?? i}`}>{findingText(t, f)}</li>)}
                        </ul>
                    )}
                </div>
            )}

            {hasStages && (
                <ol className="flex flex-col min-[900px]:flex-row min-[900px]:items-stretch gap-2 list-none p-0 m-0" data-testid="pipeline-columns">
                    {columns.map((col, i) => (
                        <React.Fragment key={col.stage}>
                            {i > 0 && (
                                <li className="flex items-center justify-center text-[var(--text-tertiary)] py-0.5 min-[900px]:py-0" aria-hidden="true" data-testid="pipeline-connector">
                                    <ArrowDown className="w-4 h-4 min-[900px]:hidden" />
                                    <ArrowRight className="w-4 h-4 hidden min-[900px]:block" />
                                </li>
                            )}
                            <li className="min-[900px]:flex-1 min-w-0">
                                <ColumnCard
                                    col={col}
                                    busy={busy}
                                    onAct={act}
                                    onOpenChecks={onOpenChecks}
                                    onOpenSettings={onOpenSettings}
                                />
                            </li>
                        </React.Fragment>
                    ))}
                </ol>
            )}

            {hasStages && pipeline.dev && (
                <section className="space-y-3">
                    <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                        {t('solution_stages.releases', 'Releases')}
                    </h3>
                    {pipeline.releases === null
                        ? <ReadProblem state="unreadable" />
                        : <ReleasesList releases={pipeline.releases} columns={columns} />}
                </section>
            )}

            {dialog && (
                <DeployDialog
                    open
                    solutionId={solutionId}
                    solutionName={solutionName}
                    request={dialog}
                    onClose={() => { setDialog(null); onReload(); }}
                    onOpenSettings={onOpenSettings}
                />
            )}
        </div>
    );
}
