/**
 * What an opened task is doing right now (./CoworkTaskView.tsx), in place of its latest result: Cowork setting up its
 * steps, a try-out (nothing is changed or sent), or a run. Each shows its parts as they go (../CoworkProgress.tsx): a
 * run that follows the steps its own steps (the run's trace), a try-out the steps it tries, the setting up the phases
 * of making the steps.
 */
import CoworkActivity, { setupActivity } from '../CoworkActivity';
import CoworkTestProgress from './CoworkTestProgress';
import { plainStepTitle } from '../coworkOverviewModel';
import { useCoworkRunTrace } from '@/api/queries/coworkPlan';
import type { PlanMaking } from '@/hooks/useCoworkPlanMaker';
import type { CoworkRun } from '@/api/cowork.types';
import type { PlanTryState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/** A run that follows the steps shows them from its trace; any other run is one line. */
function RunLive({ coworkId, run, t }: { coworkId: string; run: CoworkRun; t: TranslateFn }) {
    const trace = useCoworkRunTrace(coworkId, run.id).data;
    const steps = trace?.recorded ? trace.steps : [];
    const active = steps.findLast((step) => step.status === 'running');
    return <div data-testid="cowork-task-live"><CoworkActivity title={t('cowork_task.live.running', 'Running now')}
        tone={active?.kind === 'ai' ? 'thinking' : 'executing'} position={active ? steps.indexOf(active) / steps.length : 0} testId="cowork-task-progress"
        message={active ? plainStepTitle(active, t) : t('cowork_task.live.working', 'Working on it')} /></div>;
}

interface CoworkTaskLiveProps {
    startingTest?: boolean;
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

export default function CoworkTaskLive({ startingTest, coworkId, making, tryState, liveRun, runOrder, t }: CoworkTaskLiveProps) {
    if (making.running) return <CoworkActivity testId="cowork-task-live" {...setupActivity(making.phase, t, making.testStep)} />;
    if (startingTest || (tryState && !tryState.done)) {
        return <CoworkTestProgress state={tryState} runOrder={runOrder} t={t} />;
    }
    if (liveRun) return <RunLive coworkId={coworkId} run={liveRun} t={t} />;
    return <CoworkActivity tone="executing" message={t('cowork_task.live.working', 'Working on it')} />;
}
