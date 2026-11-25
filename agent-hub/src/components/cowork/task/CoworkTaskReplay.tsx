/**
 * "Replay on last month", under an opened task's steps (./CoworkTaskSteps.tsx): today's steps replayed on what the
 * task's past runs read (server usecases/coworkReplay.mts). No app is touched and nothing is sent. Then one line,
 * "18 of 20 the same, 2 differ", the runs that differ with their date, and the ones that are the same on request.
 */
import { useState } from 'react';
import { fullTimestamp } from '../coworkFormat';
import CoworkProgress from '../CoworkProgress';
import { BTN_LINK, CARD, CARD_HEAD, META, ROW_ACTIONS, TAG_OK, TAG_PLAIN, TAG_WARN } from './taskUi';
import type { ReplayRun, ReplayState } from '@/api/coworkReplay';
import type { TranslateFn } from '@/hooks/useTranslation';

/** "18 of 20 the same, 2 differ": only runs replayed in full count. */
function replayCounts(state: Pick<ReplayState, 'same' | 'differs'>, t: TranslateFn): string {
    const full = state.same + state.differs;
    if (full === 0) return t('cowork_task.replay.none', 'None of the past runs could be replayed in full.');
    if (state.differs === 0) return t('cowork_task.replay.all_same', '{same} of {full} the same', { same: state.same, full });
    return t('cowork_task.replay.some_differ', '{same} of {full} the same, {differs} differ', { same: state.same, full, differs: state.differs });
}

/** A step's title by its id; null for a step the plan does not have now. */
export type StepTitleOf = (stepId: string) => string | null;

/** Why a run was compared only in part. */
function partialWords(missing: number, t: TranslateFn): string {
    return missing === 1
        ? t('cowork_task.replay.partial_one', '1 step had no recording: it is new, or asks something different than then.')
        : t('cowork_task.replay.partial_line', '{count} steps had no recording: they are new, or ask something different than then.', { count: missing });
}

function RunItem({ run, titleOf, t }: { run: ReplayRun; titleOf: StepTitleOf; t: TranslateFn }) {
    const differing = run.differingSteps.map(titleOf).filter((title): title is string => !!title);
    const tag = run.verdict === 'differs'
        ? <span className={TAG_WARN}>{t('cowork_task.replay.tag_differs', 'Differs')}</span>
        : run.verdict === 'same'
            ? <span className={TAG_OK}>{t('cowork_task.replay.tag_same', 'Same')}</span>
            : <span className={TAG_PLAIN}>{t('cowork_task.replay.tag_partial', 'In part')}</span>;
    const detail = run.verdict === 'differs' && differing.length > 0
        ? t('cowork_task.replay.differs_at', 'Different at: {steps}', { steps: differing.join(', ') })
        : run.verdict === 'partial'
            ? partialWords(run.missingSteps, t)
            : '';
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px]" data-testid={`cowork-task-replay-${run.pastRunId}`}>
            {tag}
            <strong className="font-semibold">{run.startedAt ? fullTimestamp(run.startedAt, t) : ''}</strong>
            {detail && <span className="flex-1 min-w-[12rem] text-[var(--text-secondary)]">{detail}</span>}
        </li>
    );
}

export default function CoworkTaskReplay({ state, titleOf, onClose, t }: { state: ReplayState; titleOf: StepTitleOf; onClose: () => void; t: TranslateFn }) {
    const [showSame, setShowSame] = useState(false);
    if (!state.done) return <section className={CARD}><CoworkProgress labels={[t('cowork_task.replay.comparing', "Running today's steps on last month's runs. No app is touched.")]} phase={0} /></section>;
    const replayed = state.runs.filter((r) => r.verdict !== 'not_replayable');
    const same = replayed.filter((r) => r.verdict === 'same');
    const other = replayed.filter((r) => r.verdict !== 'same');
    return (
        <section className={CARD} role="status" data-testid="cowork-task-replay">
            <div className={CARD_HEAD} data-testid="cowork-task-replay-headline">{replayCounts(state, t)}</div>
            <p className={META}>
                {replayed.length === 1
                    ? t('cowork_task.replay.safe_one', "Today's steps were replayed on the last run. No app was touched and nothing was sent.")
                    : t('cowork_task.replay.safe', "Today's steps were replayed on the last {count} runs. No app was touched and nothing was sent.", { count: replayed.length })}
            </p>
            {other.length > 0 && <ul className="flex flex-col">{other.map((run) => <RunItem key={run.pastRunId} run={run} titleOf={titleOf} t={t} />)}</ul>}
            <div className={ROW_ACTIONS}>
                {same.length > 0 && (
                    <button type="button" className={BTN_LINK} aria-expanded={showSame} onClick={() => setShowSame((v) => !v)}>
                        {showSame ? t('cowork_task.replay.hide_same', 'Hide the {count} that are the same', { count: same.length }) : t('cowork_task.replay.show_same', 'Show the {count} that are the same', { count: same.length })}
                    </button>
                )}
                <button type="button" className={BTN_LINK} onClick={onClose}>{t('cowork_task.close', 'Close')}</button>
            </div>
            {showSame && <ul className="flex flex-col">{same.map((run) => <RunItem key={run.pastRunId} run={run} titleOf={titleOf} t={t} />)}</ul>}
        </section>
    );
}
