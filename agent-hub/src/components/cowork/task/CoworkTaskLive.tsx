/**
 * What an opened task is doing right now (./CoworkTaskView.tsx), in place of its latest result: Cowork setting up its
 * steps, a try-out (nothing is changed or sent), or a run. Each shows its parts as they go (../CoworkProgress.tsx): a
 * run that follows the steps its own steps (the run's trace), a try-out the steps it tries, the setting up the phases
 * of making the steps.
 */
import CoworkProgress from '../CoworkProgress';
import CoworkStatusPill from '../CoworkStatusPill';
import { plainStepTitle } from '../coworkOverviewModel';
import { inRunOrder } from './coworkTaskModel';
import { CARD, CARD_HEAD } from './taskUi';
import { useCoworkRunTrace } from '@/api/queries/coworkPlan';
import type { PlanMaking } from '@/hooks/useCoworkPlanMaker';
import type { CoworkRun } from '@/api/cowork.types';
import type { PlanTryState, PlanTryStep } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const OPEN_STEP: ReadonlySet<string> = new Set(['pending', 'running', 'queued']);

/** The steps as labels, and the phase: the first step that is not over yet. */
function stepPhases(steps: readonly PlanTryStep[], t: TranslateFn): { labels: string[]; phase: number } {
    const at = steps.findIndex((s) => OPEN_STEP.has(s.status));
    return { labels: steps.map((s) => plainStepTitle(s, t)), phase: at === -1 ? steps.length : at };
}

/** The phases of making the steps, the current one turning. */
function makingPhases(making: PlanMaking, t: TranslateFn): { labels: string[]; phase: number } {
    const phase = making.phase === 'saving' ? 1 : making.phase === 'trying' || making.phase === 'repairing' ? 2 : 0;
    return {
        phase,
        labels: [
            t('cowork_task.live.make_think', 'Working out the steps'),
            t('cowork_task.live.make_save', 'Saving them'),
            t('cowork_task.live.make_try', 'Trying them once. Nothing is changed or sent.'),
            t('cowork_task.live.make_ready', 'Ready for your check'),
        ],
    };
}

function LiveCard({ heading, testing, labels, phase }: { heading: string; testing: boolean; labels: string[]; phase: number }) {
    return (
        <section className={CARD} data-testid="cowork-task-live" aria-label={heading}>
            <div className={CARD_HEAD}><CoworkStatusPill status={testing ? 'testing' : 'running'} />{heading}</div>
            <CoworkProgress labels={labels} phase={phase} testId="cowork-task-progress" />
        </section>
    );
}

/** A run that follows the steps shows them from its trace; any other run is one line. */
function RunLive({ coworkId, run, t }: { coworkId: string; run: CoworkRun; t: TranslateFn }) {
    const trace = useCoworkRunTrace(coworkId, run.id).data;
    const parts = trace?.recorded && trace.steps.length > 0 ? stepPhases(trace.steps, t) : { labels: [t('cowork_task.live.working', 'Working on it')], phase: 0 };
    return <LiveCard heading={t('cowork_task.live.running', 'Running now')} testing={false} {...parts} />;
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
    if (making.running) return <LiveCard heading={t('cowork_task.live.setting_up', 'Setting up')} testing {...makingPhases(making, t)} />;
    if (tryState && !tryState.done) {
        return <LiveCard heading={t('cowork_task.live.trying', 'Trying it. Nothing is changed or sent.')} testing {...stepPhases(inRunOrder(tryState.steps, runOrder), t)} />;
    }
    if (liveRun) return <RunLive coworkId={coworkId} run={liveRun} t={t} />;
    return null;
}
