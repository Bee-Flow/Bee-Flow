/**
 * The latest result of an opened task (./CoworkTaskView.tsx): how its last run ended and when, the next run, the
 * result itself and its receipt ("Receipt 41 · signed"). Before a first result it says Scheduled (with the first run)
 * or Paused.
 *
 * Above it, a fix Cowork made by itself while it is still the plan: "Fixed by itself on 24 Nov: 'A week ago' now
 * reads from 'Now'. · Undo". Undo approves the version before it again (POST /api/cowork/:id/plan/restore).
 */
import { Check } from 'lucide-react';
import { fullTimestamp } from '../coworkFormat';
import { autoFixed } from '../coworkProposalModel';
import { wiringChangeWords } from '../coworkWiringModel';
import { runFailed, runLine } from './coworkTaskModel';
import { CARD, CARD_HEAD, Failure, META, ReceiptMark, UndoNote } from './taskUi';
import { useCoworkProposalActions, useCoworkProposals } from '@/api/coworkProposals';
import { useRunReceipt } from '@/api/coworkReceipts';
import { formatDate } from '@/utils/dateFormatters';
import type { CoworkProposal } from '@/api/coworkProposals';
import type { CoworkItem, CoworkRun } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/** What Cowork fixed by itself, in a sentence. */
export function autoFixWords(fix: Pick<CoworkProposal, 'reasonCode' | 'stepTitle' | 'wiring' | 'decidedAt'>, t: TranslateFn): string {
    const what = fix.reasonCode === 'wiring_fixed' && fix.wiring?.length
        ? wiringChangeWords(fix.wiring, t)
        : t('cowork_task.fix.reference', "'{step}' was reading the wrong field", { step: fix.stepTitle ?? '' });
    return t('cowork_task.fix.by_itself', 'Fixed by itself on {date}: {what}.', { date: formatDate(fix.decidedAt), what });
}

/** "Fixed by itself on … · Undo", while that fix is still the plan. */
export function AutoFixNote({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const fix = autoFixed(useCoworkProposals(coworkId).data);
    const { restore } = useCoworkProposalActions(coworkId);
    if (!fix || fix.undoVersion === null) return null;
    const version = fix.undoVersion;
    return (
        <>
            <UndoNote testId="cowork-task-autofix" undoing={restore.isPending} onUndo={() => restore.mutate(version)} t={t}>{autoFixWords(fix, t)}</UndoNote>
            <Failure error={restore.error} t={t} />
        </>
    );
}

function RunReceipt({ coworkId, runId, t }: { coworkId: string; runId: string; t: TranslateFn }) {
    const receipt = useRunReceipt(coworkId, runId, true).data;
    if (!receipt || typeof receipt.seq !== 'number') return null;
    return <ReceiptMark seq={receipt.seq} signed={receipt.signed} t={t} />;
}

/** "Done · Today 08:00", "Failed · …", "Nothing to do · …". */
function endedWords(run: CoworkRun, t: TranslateFn): { words: string; done: boolean } {
    const when = fullTimestamp(run.startedAt, t);
    if (runFailed(run)) return { words: t('cowork_task.result.failed', 'Failed · {when}', { when }), done: false };
    if (run.producedOutput === false) return { words: t('cowork_task.result.nothing', 'Nothing to do · {when}', { when }), done: false };
    return { words: t('cowork_task.result.done', 'Done · {when}', { when }), done: true };
}

/** "Next: Tomorrow 08:00" while it waits for its clock; nothing when paused or not on a clock. */
function nextWords(item: Pick<CoworkItem, 'isActive' | 'nextRunAt'>, t: TranslateFn): string | null {
    if (item.isActive === false || !item.nextRunAt || Date.parse(item.nextRunAt) <= Date.now()) return null;
    return t('cowork_task.result.next', 'Next: {when}', { when: fullTimestamp(item.nextRunAt, t) });
}

/** Before a first result: Paused, or Scheduled with when it starts. */
function NoResultYet({ item, t }: { item: Pick<CoworkItem, 'isActive' | 'nextRunAt'>; t: TranslateFn }) {
    const paused = item.isActive === false;
    const next = nextWords(item, t);
    return (
        <>
            <div className={CARD_HEAD}>{paused ? t('cowork_task.result.paused', 'Paused') : t('cowork_task.result.scheduled', 'Scheduled')}</div>
            <p className={META}>
                {paused
                    ? t('cowork_task.result.paused_line', 'Nothing runs until you resume it.')
                    : next ?? t('cowork_task.result.waits_line', 'It starts when what it waits for happens.')}
            </p>
        </>
    );
}

interface CoworkTaskResultProps {
    coworkId: string;
    item: Pick<CoworkItem, 'isActive' | 'nextRunAt'>;
    latest: CoworkRun | null;
    /** Read the latest run's receipt: only for the owner's own task. */
    withReceipt?: boolean;
    t: TranslateFn;
}

export default function CoworkTaskResult({ coworkId, item, latest, withReceipt = true, t }: CoworkTaskResultProps) {
    if (!latest) return <section className={CARD} data-testid="cowork-task-result"><NoResultYet item={item} t={t} /></section>;
    const ended = endedWords(latest, t);
    const next = nextWords(item, t);
    const text = runFailed(latest) || !latest.result ? runLine(latest, t) : latest.result;
    return (
        <section className={CARD} data-testid="cowork-task-result">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className={`${CARD_HEAD} ${ended.done ? 'text-[var(--success-ink)]' : ''}`}>
                    {ended.done && <Check aria-hidden="true" className="w-4 h-4" />}{ended.words}
                </div>
                {next && <span className={META}>{next}</span>}
            </div>
            <p className="text-[15px] leading-[1.55] whitespace-pre-wrap break-words line-clamp-[12] text-[var(--text-primary)]" data-testid="cowork-task-result-text">{text}</p>
            {withReceipt && <RunReceipt coworkId={coworkId} runId={latest.id} t={t} />}
        </section>
    );
}
