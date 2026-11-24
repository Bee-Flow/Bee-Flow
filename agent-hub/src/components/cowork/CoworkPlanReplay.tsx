/**
 * "Replay on last month": inside the plan card, while the plan differs from the one that was approved. One button
 * runs the changed plan on what the item's past runs read; nothing is read live, changed or sent. Then one headline
 * that counts only the runs replayed in full ("18 of 20 the same, 2 differ") and one plain line per past run.
 *
 * Starts the replay and follows it itself (../../api/coworkReplay.ts); ./CoworkPlanPanel.tsx decides when it shows.
 */
import { History } from 'lucide-react';
import { fullTimestamp } from './coworkFormat';
import { useCoworkPlanReplay } from '../../api/coworkReplay';
import { errorMessage } from '../../utils/caughtError';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { NotReplayableReason, ReplayRun, ReplayState } from '../../api/coworkReplay';

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';
const SECONDARY = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';

const REASON_FALLBACK: Record<NotReplayableReason, string> = {
    too_old: 'it is older than the run history keeps.',
    no_plan: 'it did not follow a plan.',
    no_automation_run: 'it left nothing to replay.',
    not_recorded: 'what it read is no longer kept.',
    failed: 'the replay of this run stopped with an error.',
};

/** The one headline: only the runs replayed in full count. */
export function replayHeadline(state: ReplayState, t: TranslateFn): string {
    if (!state.done) return t('cowork_replay.running', 'Replaying the plan on the past runs…');
    const full = state.same + state.differs;
    if (full === 0) return t('cowork_replay.headline.none_full', 'None of the past runs could be replayed in full.');
    const counts = { same: state.same, full, differs: state.differs };
    if (state.differs === 0) return t('cowork_replay.headline.all_same', '{same} of {full} the same', counts);
    if (state.differs === 1) return t('cowork_replay.headline.one_differs', '{same} of {full} the same, 1 differs', counts);
    return t('cowork_replay.headline.some_differ', '{same} of {full} the same, {differs} differ', counts);
}

/** One past run in plain words. */
export function replayLine(run: ReplayRun, t: TranslateFn): string {
    if (run.verdict === 'same') return t('cowork_replay.line.same', 'Replayed in full: it comes out the same.');
    if (run.verdict === 'differs') return t('cowork_replay.line.differs', 'Replayed in full: it comes out different.');
    if (run.verdict === 'partial') {
        return run.missingSteps === 1
            ? t('cowork_replay.line.partial_one', 'Replayed in part: 1 step had no recording. It is new, or asks something different than then.')
            : t('cowork_replay.line.partial', 'Replayed in part: {count} steps had no recording. They are new, or ask something different than then.', { count: run.missingSteps });
    }
    const reason = run.reason ?? 'failed';
    return t('cowork_replay.line.not_replayable', 'Could not be replayed: {reason}', { reason: t(`cowork_replay.reason.${reason}`, REASON_FALLBACK[reason]) });
}

function startLabel(state: ReplayState | null, starting: boolean, t: TranslateFn): string {
    if (starting) return t('cowork_replay.starting', 'Starting…');
    if (!state) return t('cowork_replay.start', 'Replay on last month');
    return state.done ? t('cowork_replay.again', 'Replay again') : t('cowork_replay.replaying', 'Replaying…');
}

function ReplayResult({ state, t }: { state: ReplayState; t: TranslateFn }) {
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-replay-result" data-done={state.done ? 'yes' : 'no'}>
            <p role="status" className="text-[12.5px] font-medium text-[var(--text-primary)]" data-testid="cowork-replay-headline">{replayHeadline(state, t)}</p>
            {state.status === 'failed' && <p className="text-[12px] text-[var(--warning-ink)]">{t('cowork_replay.stopped', 'The replay stopped before every past run was replayed.')}</p>}
            <ul className="flex flex-col gap-1">
                {state.runs.map((run) => (
                    <li key={run.pastRunId} data-testid={`cowork-replay-run-${run.pastRunId}`} data-verdict={run.verdict} className="text-[12px] text-[var(--text-secondary)]">
                        {run.startedAt && <span className="tabular-nums text-[var(--text-tertiary)]">{fullTimestamp(run.startedAt, t)} · </span>}
                        {replayLine(run, t)}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default function CoworkPlanReplay({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const { start, state, error } = useCoworkPlanReplay(coworkId);
    // A failed read ends the following: the button comes back, whatever the last state said.
    const busy = (start.isPending || (state !== null && !state.done)) && !error;
    return (
        <div className="flex flex-col gap-2 pt-2 border-t border-[var(--border-subtle)]" data-testid="cowork-replay">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="flex-1 min-w-[220px] flex flex-col gap-0.5">
                    <span className={`${LABEL} inline-flex items-center gap-1.5`}>
                        <History aria-hidden="true" className="w-3.5 h-3.5" />
                        {t('cowork_replay.heading', 'Replay on last month')}
                    </span>
                    <span className="text-[12px] text-[var(--text-secondary)]">
                        {t('cowork_replay.hint', 'Runs the changed plan on what the earlier runs read. Nothing is read from your apps, changed or sent.')}
                    </span>
                </div>
                <button type="button" data-testid="cowork-replay-start" className={SECONDARY} disabled={busy} onClick={() => start.mutate()}>
                    {startLabel(state, start.isPending, t)}
                </button>
            </div>
            {error && <p role="alert" className="text-[12.5px] text-[var(--error-ink)]">{errorMessage(error) || t('cowork_plan.failed', 'That did not work. Try again.')}</p>}
            {state && <ReplayResult state={state} t={t} />}
        </div>
    );
}
