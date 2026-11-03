import { useTranslation } from '@/hooks/useTranslation';
import { usePendingApproval, type PendingApprovalSnapshot } from '@/api/queries/automation/pendingApproval';
import type { ApprovalField } from '@/components/admin/Studio/Approvals/ApprovalDecisionControls';
import { runPhase, type RunPhaseInput } from '../runs/runPhase';
import ApprovalActionBar from './ApprovalActionBar';

/** The run the builder follows (`state.dryRun`), as far as the bar reads it. */
export interface FollowedRunLike extends RunPhaseInput {
    id?: string;
    /** The step the journey waits on (GET /runs/:id reports the newest leg's). */
    awaitingStepId?: unknown;
}

/** The step row on the canvas, as far as the bar reads it. */
interface StepRowLike {
    status?: string;
    output?: unknown;
}

/**
 * The run to decide on, when the followed run waits for a decision on THIS
 * step; else null. The run's phase decides, never the step row alone: a row
 * keeps saying "awaiting_approval" for a moment after the decision while the
 * run already goes on, and a row from an older run says it forever (run-watch
 * F2, F10). The row only stands in for a run row that does not name its
 * waiting step. A run-level first-run confirm (awaiting_confirm) is not a step's.
 */
function pausedApprovalRunId(run: FollowedRunLike | null | undefined, stepId: string | null | undefined, runStep: StepRowLike | null | undefined): string | null {
    if (!run?.id || !stepId || run.status === 'awaiting_confirm') return null;
    if (runPhase(run).phase !== 'paused_approval') return null;
    const awaiting = typeof run.awaitingStepId === 'string' && run.awaitingStepId ? run.awaitingStepId : null;
    const here = awaiting ? awaiting === stepId : runStep?.status === 'awaiting_approval';
    return here ? run.id : null;
}

interface PausedApprovalBarProps {
    run: FollowedRunLike | null | undefined;
    stepId: string | null | undefined;
    runStep: StepRowLike | null | undefined;
    /** The canvas follows the journey after the decision (useBuilderRuns.onFollowRun). */
    onFollowRun?: ((runId: string) => void) | null;
}

/**
 * The step drawer's approval bar: shown only while the followed run waits on
 * this step, and rendered from the approval row's SNAPSHOT (GET
 * /runs/:runId/form pendingApproval): the question as it was put, and the
 * questions the server will check the answers against. Never from the step
 * as it is on the canvas now (pauses F5): the author may have edited it while
 * the run waited.
 */
export default function PausedApprovalBar({ run, stepId, runStep, onFollowRun = null }: PausedApprovalBarProps) {
    const runId = pausedApprovalRunId(run, stepId, runStep);
    if (!runId || !stepId) return null;
    return <SnapshotBar runId={runId} stepId={stepId} isTest={runPhase(run).isTest} runStep={runStep} onFollowRun={onFollowRun} />;
}

interface SnapshotBarProps {
    runId: string;
    stepId: string;
    isTest: boolean;
    runStep: StepRowLike | null | undefined;
    onFollowRun: ((runId: string) => void) | null;
}

/** The question the run row recorded when it paused: the stand-in while no snapshot can be read. */
function recordedPrompt(runStep: StepRowLike | null | undefined): unknown {
    const out = runStep?.output;
    return out && typeof out === 'object' ? (out as { prompt?: unknown }).prompt : null;
}

function SnapshotBar({ runId, stepId, isTest, runStep, onFollowRun }: SnapshotBarProps) {
    const { t } = useTranslation();
    const query = usePendingApproval(runId, stepId);
    if (query.isPending) {
        return (
            <div className="mx-3 mt-3 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-[var(--text-secondary)]" data-testid="approval-action-bar-loading">
                {t('automations.approval_action_bar.loading', 'Reading the decision this run waits for…')}
            </div>
        );
    }
    // No snapshot (a run paused before approvals had rows, or one the reader
    // may not open): the decision still works, without extra questions.
    const snap: PendingApprovalSnapshot | null = query.data ?? null;
    return (
        <ApprovalActionBar
            runId={runId}
            stepId={stepId}
            prompt={snap?.prompt || recordedPrompt(runStep)}
            fields={snap ? snap.fields as ApprovalField[] : null}
            canDecide={snap ? snap.canDecide : true}
            waitingOn={snap?.waitingOn ?? null}
            isTest={snap ? snap.isTest : isTest}
            onFollowRun={onFollowRun}
            // A vote leaves the run waiting: read who it waits on now.
            onResolved={() => { void query.refetch(); }}
        />
    );
}
