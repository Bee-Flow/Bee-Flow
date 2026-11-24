/**
 * What an opened task is doing right now (./CoworkTaskView.tsx), in place of its latest result: Cowork setting up its
 * steps, a try-out (nothing is changed or sent), or a run. Each shows its parts as they go: a plan run its own steps
 * (the run's trace), a try-out the steps it tries, the setting up the phases of making the steps.
 */
import { useCoworkRunTrace } from '@/api/queries/coworkPlan';
import { plainStepTitle } from '../coworkOverviewModel';
import { inRunOrder } from './coworkTaskModel';
import { CARD, CARD_HEAD, ProgressList, StatusPill, type ProgressState } from './taskUi';
import { tokenFor } from '../../shared/statusTokens';
import type { PlanMaking } from '@/hooks/useCoworkPlanMaker';
import type { CoworkRun } from '@/api/cowork.types';
import type { PlanTryState, PlanTryStep } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

type Row = { key: string; label: string; state: ProgressState };

const DONE_STEP: ReadonlySet<string> = new Set(['success', 'completed', 'done', 'skipped', 'held', 'failed', 'error', 'not_reached']);

function stepRows(steps: readonly PlanTryStep[], t: TranslateFn): Row[] {
    return steps.map((step) => ({
        key: step.id,
        label: plainStepTitle(step, t),
        state: step.status === 'running' ? 'now' : DONE_STEP.has(step.status) ? 'did' : 'next',
    }));
}

/** The phases of making the steps, the current one turning. */
function makingRows(making: PlanMaking, t: TranslateFn): Row[] {
    const at = making.phase === 'saving' ? 1 : making.phase === 'trying' || making.phase === 'repairing' ? 2 : 0;
    const labels = [
        t('cowork_task.live.make_think', 'Working out the steps'),
        t('cowork_task.live.make_save', 'Saving them'),
        t('cowork_task.live.make_try', 'Trying them once. Nothing is changed or sent.'),
        t('cowork_task.live.make_ready', 'Ready for your check'),
    ];
    return labels.map((label, i) => ({ key: String(i), label, state: i < at ? 'did' : i === at ? 'now' : 'next' }));
}

function LiveCard({ heading, testing, rows, t }: { heading: string; testing: boolean; rows: Row[]; t: TranslateFn }) {
    return (
        <section className={CARD} data-testid="cowork-task-live" aria-label={heading}>
            <div className={CARD_HEAD}>
                <StatusPill token={testing ? { ...tokenFor('running'), labelKey: 'cowork_task.status.testing', labelEn: 'Testing' } : tokenFor('running')} t={t} />
                {heading}
            </div>
            <ProgressList rows={rows} />
        </section>
    );
}

/** A run that follows the steps shows them from its trace; any other run is one line. */
function RunLive({ coworkId, run, t }: { coworkId: string; run: CoworkRun; t: TranslateFn }) {
    const trace = useCoworkRunTrace(coworkId, run.id).data;
    const rows = trace?.recorded && trace.steps.length > 0
        ? stepRows(trace.steps, t)
        : [{ key: 'run', label: t('cowork_task.live.working', 'Working on it'), state: 'now' as const }];
    return <LiveCard heading={t('cowork_task.live.running', 'Running now')} testing={false} rows={rows} t={t} />;
}

interface CoworkTaskLiveProps {
    coworkId: string;
    making: PlanMaking;
    tryState: PlanTryState | null;
    liveRun: CoworkRun | null;
    /** The plan's own run order, for the steps of a try-out. */
    runOrder?: string[];
    t: TranslateFn;
}

/** Whether there is something on the go to show. */
export function isLive({ making, tryState, liveRun }: Pick<CoworkTaskLiveProps, 'making' | 'tryState' | 'liveRun'>): boolean {
    return making.running || (!!tryState && !tryState.done) || !!liveRun;
}

export default function CoworkTaskLive({ coworkId, making, tryState, liveRun, runOrder, t }: CoworkTaskLiveProps) {
    if (making.running) return <LiveCard heading={t('cowork_task.live.setting_up', 'Setting up')} testing rows={makingRows(making, t)} t={t} />;
    if (tryState && !tryState.done) {
        return <LiveCard heading={t('cowork_task.live.trying', 'Trying it. Nothing is changed or sent.')} testing rows={stepRows(inRunOrder(tryState.steps, runOrder), t)} t={t} />;
    }
    if (liveRun) return <RunLive coworkId={coworkId} run={liveRun} t={t} />;
    return null;
}
