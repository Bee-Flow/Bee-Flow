import { AlertTriangle, ArrowRight, ChevronRight, Loader2, Lock } from 'lucide-react';
import React, { useEffect } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DeployDialog from './DeployDialog';
import { actionLabel, usePipelineActions, type T } from './pipelineActions';
import { buildColumns, type Column, type ColumnAction, type ErrorKind, type PipelineReadState } from './pipelineModel';
import { errorText, findingText } from './StageStatus';
import { STAGE_DOT, STAGE_ICON, STAGE_INK, STAGE_RULE, STAGE_TINT, useStageLabel } from './StageSwitcher';
import type { Pipeline, PlanFinding, StageKey, StageName } from './stagesApi';

/**
 * Dev → UAT → Production, always in view under the header of a Solution.
 *
 * Each stage shows where it stands (its release, or what is waiting) and opens
 * that stage when clicked; ONE button on the right is the next step the pipeline
 * offers (set up stages, release and deploy to UAT, promote to Production). The
 * decisions live in pipelineModel.ts (`buildColumns`), the same ones the
 * Pipeline tab renders, and the actions are the same hook, so this strip and
 * that tab can never disagree about what the next step is. A reader who is not
 * the owner sees the strip and no button.
 *
 * Without a licence the strip says so in one line; a pipeline that could not be
 * read says that instead. Neither is dressed up as "no stages".
 */

export interface StageRailProps {
    solutionId: string;
    solutionName: string;
    pipeline: Pipeline | null;
    readState: PipelineReadState;
    owner: boolean;
    active: StageName;
    onSelect: (stage: StageName) => void;
    onReload: () => void;
    onOpenSettings?: (stage: StageKey) => void;
    /** Offer the next-step button. The Pipeline tab has its own, and a stage view has none. */
    showAction: boolean;
    /** Re-read while a deployment runs. Off where the Pipeline tab already does. */
    poll: boolean;
    pollMs?: number;
}

/** The words under a stage's name. A failed or half-finished last deployment outranks its state. */
function noteOf(t: T, col: Column): string {
    const notes: Record<Column['state'], () => string> = {
        no_stages: () => '',
        blocked: () => t('solution_stages.rail_dev_blocked', '{count} to fix', { count: col.blockedCount ?? 0 }),
        no_release: () => t('solution_stages.rail_dev_no_release', 'No release yet'),
        ahead: () => (col.releaseSeq !== null
            ? t('solution_stages.rail_dev_changes_since', 'Changes since R{seq}', { seq: col.releaseSeq })
            : t('solution_stages.rail_dev_changes', 'Unreleased changes')),
        in_sync: () => t('solution_stages.rail_dev_in_sync', 'In sync'),
        not_set_up: () => t('solution_stages.rail_not_set_up', 'Not set up'),
        waiting: () => t('solution_stages.rail_waiting', 'Waiting for a release'),
        empty: () => t('solution_stages.rail_empty', 'Nothing deployed'),
        behind: () => t('solution_stages.rail_behind', 'Newer release ready'),
        promote: () => t('solution_stages.rail_promote', 'Behind UAT'),
        current: () => t('solution_stages.rail_current', 'Up to date'),
        running: () => t('solution_stages.rail_running', 'Deploying'),
        awaiting_approval: () => t('solution_stages.rail_awaiting', 'Awaiting approval'),
    };
    if (col.stage !== 'dev' && col.attention === 'failed') return t('solution_stages.rail_failed', 'Last deployment failed');
    if (col.stage !== 'dev' && col.attention === 'warnings') return t('solution_stages.rail_warnings', 'Needs attention');
    return notes[col.state]();
}

function StageNode({ col, active, onSelect }: { col: Column; active: boolean; onSelect: (s: StageName) => void }) {
    const { t } = useTranslation();
    const label = useStageLabel();
    const Icon = STAGE_ICON[col.stage];
    const openable = col.stage === 'dev' || col.state !== 'not_set_up';
    const body = (
        <>
            <span className="flex items-center gap-1.5 min-w-0">
                <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${STAGE_DOT[col.stage]}`} aria-hidden="true" />
                <Icon className={`w-4 h-4 flex-shrink-0 ${STAGE_INK[col.stage]}`} aria-hidden="true" />
                <span className={`text-[13px] font-semibold truncate ${STAGE_INK[col.stage]}`}>{label(col.stage)}</span>
                {col.stage !== 'dev' && col.releaseSeq !== null && (
                    <span className="ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" data-testid={`stage-rail-release-${col.stage}`}>
                        {t('solution_stages.release_short', 'R{seq}', { seq: col.releaseSeq })}
                    </span>
                )}
                {col.state === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none text-[var(--text-tertiary)]" aria-hidden="true" />}
                {col.stage !== 'dev' && (col.attention !== null) && (
                    <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 ${col.attention === 'failed' ? 'text-[var(--error)]' : 'text-[var(--warning)]'}`} aria-hidden="true" />
                )}
            </span>
            <span className="block mt-0.5 text-[12px] text-[var(--text-tertiary)] truncate" data-testid={`stage-rail-note-${col.stage}`}>{noteOf(t, col)}</span>
        </>
    );
    // The active stage wears a 2px rule in its colour and a tint; the rest stay calm cards.
    const rule = active ? `border-t-2 ${STAGE_RULE[col.stage]} ${STAGE_TINT[col.stage]}` : 'bg-[var(--bg-card)]';
    const base = `block w-full min-h-[48px] px-3 py-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] text-left ${rule}`;
    return openable ? (
        <button type="button" aria-pressed={active} aria-current={active ? 'step' : undefined} onClick={() => onSelect(col.stage)}
                data-testid={`stage-rail-${col.stage}`} data-state={col.state}
                className={`${base} transition-colors motion-reduce:transition-none hover:border-[var(--border-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]`}>
            {body}
        </button>
    ) : (
        <div data-testid={`stage-rail-${col.stage}`} data-state={col.state} className={`${base} opacity-70 border-dashed`}>{body}</div>
    );
}

function RailProblem({ problem, findings }: { problem: ErrorKind; findings: PlanFinding[] }) {
    const { t } = useTranslation();
    return (
        <div className="px-3 py-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] border-l-[3px] border-l-[var(--warning)] text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] space-y-1" role="alert" data-testid="stage-rail-problem" data-kind={problem}>
            <p>{errorText(t, problem)}</p>
            {findings.length > 0 && (
                <ul className="list-disc pl-5 text-[var(--text-secondary)]">
                    {findings.map((f, i) => <li key={`${f.code}:${f.ref ?? i}`}>{findingText(t, f)}</li>)}
                </ul>
            )}
        </div>
    );
}

/** Re-read the pipeline while a deployment runs, so the strip follows it to the end. */
function useRunningPoll(on: boolean, onReload: () => void, pollMs: number) {
    useEffect(() => {
        if (!on) return undefined;
        const id = setInterval(onReload, pollMs);
        return () => clearInterval(id);
    }, [on, onReload, pollMs]);
}

/** One line instead of the strip: stages are not in the plan, or could not be read. */
function Hint({ state }: { state: 'no_licence' | 'unreadable' }) {
    const { t } = useTranslation();
    const locked = state === 'no_licence';
    const Icon = locked ? Lock : AlertTriangle;
    return (
        <div className="px-4 md:px-6 pt-3">
            <p className="inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]" data-testid={locked ? 'stage-rail-locked' : 'stage-rail-unreadable'} data-state={state}>
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                {locked
                    ? t('solution_stages.rail_locked', 'Dev, UAT and Production stages are not part of your plan.')
                    : t('solution_stages.rail_unreadable', 'The stages could not be read. Try again shortly.')}
            </p>
        </div>
    );
}

function RailStrip({ columns, active, onSelect, next, busy, onAct }: {
    columns: Column[]; active: StageName; onSelect: (s: StageName) => void;
    next: ColumnAction | null; busy: boolean; onAct: (a: ColumnAction) => void;
}) {
    const { t } = useTranslation();
    const stageName = useStageLabel();
    return (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            {/* Under 640px the three stages become a scroll-snap strip: the only thing allowed to scroll sideways. */}
            <ol className="flex flex-1 min-w-0 items-stretch gap-1 overflow-x-auto snap-x snap-mandatory sm:overflow-visible pb-1 sm:pb-0" aria-label={t('solution_stages.rail_label', 'Release stages')}>
                {columns.map((col, i) => (
                    <li key={col.stage} className="flex flex-1 min-w-[10.5rem] sm:min-w-0 snap-start items-center gap-1">
                        {i > 0 && <ChevronRight className="w-4 h-4 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />}
                        <div className="flex-1 min-w-0">
                            <StageNode col={col} active={col.stage === active} onSelect={onSelect} />
                        </div>
                    </li>
                ))}
            </ol>
            {next && (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAct(next)}
                    data-testid="stage-rail-action"
                    className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-[var(--radius-sm)] text-[13px] font-medium disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2"
                >
                    {busy && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    {actionLabel(t, next, stageName)}
                    {!busy && <ArrowRight className="w-4 h-4" aria-hidden="true" />}
                </button>
            )}
        </div>
    );
}

export default function StageRail({
    solutionId, solutionName, pipeline, readState, owner, active, onSelect, onReload, onOpenSettings, showAction, poll, pollMs = 4000,
}: StageRailProps) {
    const { dialog, setDialog, busy, problem, findings, act } = usePipelineActions(solutionId, onReload);
    const columns = readState === 'ok' && pipeline ? buildColumns(pipeline, { owner }) : [];
    useRunningPoll(poll && columns.some(c => c.state === 'running'), onReload, pollMs);

    if (readState === 'no_licence' || readState === 'unreadable') return <Hint state={readState} />;
    if (readState !== 'ok' || !pipeline || columns.length === 0) return null;

    const next = showAction ? columns.find(c => c.primary)?.primary ?? null : null;

    return (
        <div className="px-4 md:px-6 pt-3 space-y-2" data-testid="stage-rail" data-active={active}>
            <RailStrip columns={columns} active={active} onSelect={onSelect} next={next} busy={busy} onAct={(a) => void act(a)} />

            {problem && <RailProblem problem={problem} findings={findings} />}

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
