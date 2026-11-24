/**
 * The runs of an opened task ("Runs" under History, ./CoworkTaskHistory.tsx; "Earlier runs" of a task someone shared,
 * ./CoworkTaskShared.tsx): one row per run with when, its status word and one plain line. Opened, why it went that way
 * in plain words (the server's own sentence, the review's reason, or a general one) and its receipt, with "Signature
 * checked" once the receipt is signed and the chain of receipts holds.
 *
 * A run's raw error is shown only under "Technical details" in its opened row, never in a line a person reads.
 */
import { useId, useState } from 'react';
import { fullTimestamp } from '../coworkFormat';
import { Expand } from '../coworkMotion';
import { taskStatusLabel } from '../coworkTaskStatus';
import { runLine, runReason, runStatus } from './coworkTaskModel';
import { TechnicalDetails } from './taskRows';
import { Chevron, LABEL, ReceiptMark, ROW_ACTIONS, TAG_OK } from './taskUi';
import { useReceipts, useRunReceipt } from '@/api/coworkReceipts';
import type { CoworkRun } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const SHOWN = 10;

function Receipt({ coworkId, runId, t }: { coworkId: string; runId: string; t: TranslateFn }) {
    const receipt = useRunReceipt(coworkId, runId, true).data;
    const chain = useReceipts(coworkId).data;
    if (!receipt || typeof receipt.seq !== 'number') return null;
    const checked = receipt.signed && !!chain?.verdict.ok;
    return (
        <span className={ROW_ACTIONS}>
            <ReceiptMark seq={receipt.seq} signed={receipt.signed} t={t} />
            {checked && <span className={TAG_OK}>{t('cowork_task.runs.signature_checked', 'Signature checked')}</span>}
        </span>
    );
}

function RunRow({ run, coworkId, open, onToggle, withReceipts, t }: { run: CoworkRun; coworkId: string; open: boolean; onToggle: () => void; withReceipts: boolean; t: TranslateFn }) {
    const status = runStatus(run);
    const bodyId = useId();
    return (
        <li className="border-t first:border-t-0 border-[var(--border-subtle)]" data-testid="cowork-task-run">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={onToggle}
                className="w-full min-h-11 py-3 grid grid-cols-[minmax(0,1fr)_auto_16px] sm:grid-cols-[110px_120px_minmax(0,1fr)_16px] items-center gap-x-3 gap-y-1 text-left text-[14px]"
            >
                <span className="text-[var(--text-secondary)] tabular-nums">{fullTimestamp(run.startedAt, t)}</span>
                <span className="font-medium text-[var(--text-primary)]" data-status={status}>{taskStatusLabel(status, t)}</span>
                <span className="col-span-full row-start-2 sm:col-span-1 sm:row-start-auto min-w-0 truncate text-[var(--text-secondary)]" data-testid="cowork-task-run-line">{runLine(run, t)}</span>
                <span className="col-start-3 row-start-1 sm:col-start-4"><Chevron open={open} /></span>
            </button>
            <Expand open={open} id={bodyId} className="pb-3.5 flex flex-col gap-2 text-[14px] leading-5 text-[var(--text-primary)]">
                <span className="whitespace-pre-wrap break-words" data-testid="cowork-task-run-detail">{runReason(run, t)}</span>
                <TechnicalDetails text={run.error} t={t} />
                {withReceipts && <Receipt coworkId={coworkId} runId={run.id} t={t} />}
            </Expand>
        </li>
    );
}

interface CoworkTaskRunsProps {
    coworkId: string;
    runs: CoworkRun[];
    /** Read each run's receipt when opened: only for the owner's own task. */
    withReceipts: boolean;
    /** What the list is called where it is shown. */
    heading: string;
    t: TranslateFn;
}

export default function CoworkTaskRuns({ coworkId, runs, withReceipts, heading, t }: CoworkTaskRunsProps) {
    const [open, setOpen] = useState<string | null>(null);
    const done = runs.filter((r) => r.status !== 'running').slice(0, SHOWN);
    return (
        <div className="flex flex-col gap-1" data-testid="cowork-task-runs">
            <span className={LABEL}>{heading}</span>
            {done.length === 0 && <p className="text-[14px] text-[var(--text-secondary)]">{t('cowork_task.runs.none', 'It has not run yet.')}</p>}
            <ul className="list-none m-0 p-0">
                {done.map((run) => (
                    <RunRow key={run.id} run={run} coworkId={coworkId} open={open === run.id} onToggle={() => setOpen((o) => (o === run.id ? null : run.id))} withReceipts={withReceipts} t={t} />
                ))}
            </ul>
        </div>
    );
}
