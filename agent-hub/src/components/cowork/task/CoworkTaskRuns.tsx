/**
 * "Earlier runs", in an opened task (./CoworkTaskView.tsx): one row per run with when, its status word and one plain
 * line. Opened, the reason it went that way (the AI's own verdict or the review's reason where there is one) and its
 * receipt, with "Signature checked" once the receipt is signed and the chain of receipts holds.
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { fullTimestamp } from '../coworkFormat';
import { runStatusToken } from '../coworkStatus';
import { statusLabel } from '../../shared/statusTokens';
import { runLine, runReason } from './coworkTaskModel';
import { ReceiptMark, ROW_ACTIONS, SECTION_H, TAG_OK } from './taskUi';
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
    const status = runStatusToken(run.status);
    return (
        <li className="border-t first:border-t-0 border-[var(--border-subtle)]" data-testid="cowork-task-run">
            <button
                type="button"
                aria-expanded={open}
                onClick={onToggle}
                className="w-full min-h-[44px] py-3 grid grid-cols-[minmax(0,1fr)_auto_16px] sm:grid-cols-[110px_120px_minmax(0,1fr)_16px] items-center gap-x-3 gap-y-1 text-left text-[14px]"
            >
                <span className="text-[var(--text-secondary)] tabular-nums">{fullTimestamp(run.startedAt, t)}</span>
                <span className="font-semibold text-[var(--text-primary)]" data-status-key={status.labelKey}>{statusLabel(t, status)}</span>
                <span className="col-span-full row-start-2 sm:col-span-1 sm:row-start-auto min-w-0 truncate text-[var(--text-secondary)]">{runLine(run, t)}</span>
                <ChevronDown aria-hidden="true" className={`w-4 h-4 text-[var(--text-tertiary)] col-start-3 row-start-1 sm:col-start-4 motion-safe:transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="pb-3.5 flex flex-col gap-2 text-[14px] text-[var(--text-primary)]" data-testid="cowork-task-run-detail">
                    <span className="whitespace-pre-wrap break-words">{runReason(run, t)}</span>
                    {withReceipts && <Receipt coworkId={coworkId} runId={run.id} t={t} />}
                </div>
            )}
        </li>
    );
}

interface CoworkTaskRunsProps {
    coworkId: string;
    runs: CoworkRun[];
    /** Read each run's receipt when opened: only for the owner's own task. */
    withReceipts: boolean;
    t: TranslateFn;
}

export default function CoworkTaskRuns({ coworkId, runs, withReceipts, t }: CoworkTaskRunsProps) {
    const [open, setOpen] = useState<string | null>(null);
    const done = runs.filter((r) => r.status !== 'running').slice(0, SHOWN);
    if (done.length === 0) return null;
    return (
        <section aria-labelledby="cowork-task-runs-h" className="flex flex-col gap-2" data-testid="cowork-task-runs">
            <h3 id="cowork-task-runs-h" className={SECTION_H}>{t('cowork_task.runs.heading', 'Earlier runs')}</h3>
            <ul className="list-none m-0 p-0">
                {done.map((run) => (
                    <RunRow key={run.id} run={run} coworkId={coworkId} open={open === run.id} onToggle={() => setOpen((o) => (o === run.id ? null : run.id))} withReceipts={withReceipts} t={t} />
                ))}
            </ul>
        </section>
    );
}
