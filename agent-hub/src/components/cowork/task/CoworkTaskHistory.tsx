/**
 * "History", at the end of an opened task (./CoworkTaskView.tsx): what happened to it, and the way out of it.
 *
 *   - Runs: each run in plain words (./CoworkTaskRuns.tsx);
 *   - Changes: who changed what and when, Cowork's own changes tagged "Cowork, automatic". A change that approved a
 *     version of the steps the server still has can be brought back ("Restore these steps": POST
 *     /api/cowork/:id/plan/restore); every other entry is read only;
 *   - Proof of each run: whether the chain of run receipts holds, checked again on request, and the chain as a
 *     download.
 *
 * "Delete this task" is at the very bottom and asks in the page itself; once the task is gone the page closes. The
 * server keeps no deleted task, so there is no Undo for it.
 */
import { useState } from 'react';
import { fullTimestamp } from '../coworkFormat';
import { ENTER } from '../coworkMotion';
import { trailLine } from '../coworkTrailModel';
import CoworkTaskRuns from './CoworkTaskRuns';
import { ROWS } from './taskRows';
import { BTN_DANGER, BTN_LINK, BTN_QUIET, CARD, Failure, FoldRow, META, ROW_ACTIONS, TAG_ACCENT, TAG_PLAIN } from './taskUi';
import { useCoworkProposalActions } from '@/api/coworkProposals';
import { receiptsUrl, useReceipts, type ReceiptsView } from '@/api/coworkReceipts';
import { useCoworkItemActions } from '@/api/coworkTask';
import { useCoworkTrail, type TrailEntry } from '@/api/coworkTrail';
import type { PlanState } from '@/api/coworkPlan.types';
import type { CoworkItem, CoworkRun } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const PROBLEMS: Record<string, [string, string]> = {
    gap: ['cowork_task.receipts.gap', 'Receipt {seq} is missing from the chain.'],
    link: ['cowork_task.receipts.link', 'Receipt {seq} does not follow the one before it.'],
    content: ['cowork_task.receipts.content', 'Receipt {seq} was changed after it was issued.'],
    signature: ['cowork_task.receipts.signature', 'Receipt {seq} does not carry a valid signature.'],
};

/** Whether the chain holds, in one line. */
function chainWords(view: ReceiptsView | undefined, t: TranslateFn): string {
    if (!view?.verdict || view.verdict.count === 0) return t('cowork_task.receipts.none', 'No receipts yet');
    const problem = view.verdict.problem;
    if (problem) {
        const [key, en] = PROBLEMS[problem.kind] ?? PROBLEMS.content;
        return t(key, en, { seq: problem.seq });
    }
    if (view.missingRuns === 1) return t('cowork_task.receipts.missing_one', '1 finished run has no receipt.');
    if (view.missingRuns > 0) return t('cowork_task.receipts.missing', '{count} finished runs have no receipt.', { count: view.missingRuns });
    if (view.verdict.count === 1) return t('cowork_task.receipts.ok_one', 'The one receipt checks out');
    return t('cowork_task.receipts.ok', 'All {count} receipts check out', { count: view.verdict.count });
}

export function ProofBody({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const receipts = useReceipts(coworkId);
    const [checked, setChecked] = useState(false);
    const again = () => { receipts.refetch().then(() => setChecked(true)).catch(() => undefined); };
    const holds = !receipts.data?.verdict?.problem && !receipts.data?.missingRuns;
    return (
        <>
            <p className={`text-[14px] ${holds ? 'text-[var(--success-ink)]' : 'text-[var(--warning-ink)]'}`} role="status">
                {receipts.isFetching ? t('cowork_task.receipts.checking', 'Checking the receipts…') : chainWords(receipts.data, t)}
                {checked && !receipts.isFetching ? ` ${t('cowork_task.receipts.just_now', '(checked just now)')}` : ''}
            </p>
            <p className={META}>{t('cowork_task.receipts.hint', 'Every run leaves a signed receipt: what ran, when, and what it changed or sent. If someone altered one later, this check would show it.')}</p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_QUIET} disabled={receipts.isFetching} onClick={again}>{t('cowork_task.receipts.check', 'Check again')}</button>
                <a className={BTN_QUIET} href={receiptsUrl(coworkId)} download={`cowork-receipts-${coworkId}.json`}>{t('cowork_task.receipts.export', 'Export receipts')}</a>
            </div>
            <Failure error={receipts.error} t={t} />
        </>
    );
}

/** The version of the steps a change approved, when the trail kept it; null for any other change. */
function versionOf(entry: TrailEntry): number | null {
    const version = entry.values?.version;
    return typeof version === 'number' && entry.action.startsWith('cowork.plan_') ? version : null;
}

interface ChangeProps { entry: TrailEntry; current: number | null; busy: boolean; onRestore: (version: number) => void; t: TranslateFn }

function Change({ entry, current, busy, onRestore, t }: ChangeProps) {
    const version = versionOf(entry);
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px]" data-testid="cowork-task-change">
            <span className="basis-[96px] flex-shrink-0 tabular-nums text-[var(--text-tertiary)]">{entry.at ? fullTimestamp(entry.at, t) : ''}</span>
            {entry.byCowork && <span className={TAG_ACCENT}>{t('cowork_task.history.cowork', 'Cowork, automatic')}</span>}
            <span className="flex-1 basis-[200px] min-w-0 break-words">{trailLine(entry, t)}</span>
            {version !== null && current !== null && version === current && <span className={TAG_PLAIN}>{t('cowork_task.changes.current', 'The steps as they are now')}</span>}
            {version !== null && current !== null && version !== current && (
                <button type="button" className={BTN_LINK} disabled={busy} onClick={() => onRestore(version)}>{t('cowork_task.changes.restore', 'Restore these steps')}</button>
            )}
        </li>
    );
}

export function ChangesBody({ coworkId, plan, t }: { coworkId: string; plan: PlanState | undefined; t: TranslateFn }) {
    const trail = useCoworkTrail(coworkId, true);
    const { restore } = useCoworkProposalActions(coworkId);
    const [restored, setRestored] = useState(false);
    const entries = trail.data ?? [];
    const onRestore = (version: number) => {
        setRestored(false);
        restore.mutate(version, { onSuccess: () => { setRestored(true); void trail.refetch(); } });
    };
    if (trail.isSuccess && entries.length === 0) return <p className={META}>{t('cowork_task.history.empty', 'No changes recorded yet.')}</p>;
    return (
        <>
            {restored && <p role="status" className={META} data-testid="cowork-task-restored">{t('cowork_task.changes.restored', 'Restored. The steps are as they were then, and approved.')}</p>}
            <ul className="list-none m-0 p-0">
                {entries.map((entry, i) => (
                    <Change key={`${entry.action}-${entry.at ?? i}-${i}`} entry={entry} current={plan?.approved?.version ?? null} busy={restore.isPending} onRestore={onRestore} t={t} />
                ))}
            </ul>
            <p className={META}>{t('cowork_task.changes.restore_hint', 'Restore brings back the steps as they were approved then. Nothing else of the task changes.')}</p>
            <Failure error={trail.error || restore.error} t={t} />
        </>
    );
}

export function DeleteTask({ item, onGone, onCancel, t }: { item: Pick<CoworkItem, 'id' | 'title'>; onGone: () => void; onCancel?: () => void; t: TranslateFn }) {
    const { remove } = useCoworkItemActions(item.id);
    const [confirming, setConfirming] = useState(false);
    if (!confirming && !onCancel) {
        return <div><button type="button" className={`${BTN_LINK} text-[var(--error-ink)]`} onClick={() => setConfirming(true)}>{t('cowork_task.more.delete', 'Delete this task')}</button></div>;
    }
    return (
        <div className={`${CARD} ${ENTER}`} role="group" aria-label={t('cowork_task.more.delete', 'Delete this task')}>
            <p className="text-[14px] text-[var(--text-primary)]" data-testid="cowork-task-delete-confirm">
                {t('cowork_task.delete.confirm', "Delete '{title}'? It stops for good, with its runs. This cannot be undone.", { title: item.title })}
            </p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_DANGER} disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onGone })}>{t('cowork_task.delete.go', 'Delete task')}</button>
                <button type="button" className={BTN_QUIET} disabled={remove.isPending} onClick={onCancel ?? (() => setConfirming(false))}>{t('cowork_task.keep_it', 'Keep it')}</button>
            </div>
            <Failure error={remove.error} t={t} />
        </div>
    );
}

interface CoworkTaskHistoryProps {
    item: Pick<CoworkItem, 'id' | 'title'>;
    runs: CoworkRun[];
    onSteps?: () => void;
    plan: PlanState | undefined;
    /** The task is gone (deleted): the page closes. */
    onGone: () => void;
    t: TranslateFn;
}

type HistoryRowId = 'changes' | 'proof';

export default function CoworkTaskHistory({ item, runs, plan, onGone, onSteps, t }: CoworkTaskHistoryProps) {
    const [open, setOpen] = useState<HistoryRowId | null>(null);
    const proof = chainWords(useReceipts(item.id).data, t);
    const row = (id: HistoryRowId) => ({ id, open: open === id, onToggle: (next: string | null) => setOpen(next as HistoryRowId | null) });
    return (
        <div className="flex flex-col gap-3" data-testid="cowork-task-history">
            <CoworkTaskRuns coworkId={item.id} runs={runs} onSteps={onSteps} withReceipts heading={t('cowork_task.history.runs', 'Runs')} t={t} />
            <div className={ROWS}>
                <FoldRow {...row('changes')} label={t('cowork_task.history.changes', 'Changes')}>
                    <ChangesBody coworkId={item.id} plan={plan} t={t} />
                </FoldRow>
                <FoldRow {...row('proof')} label={t('cowork_task.history.proof', 'Proof of each run')} value={proof}>
                    <ProofBody coworkId={item.id} t={t} />
                </FoldRow>
            </div>
            <DeleteTask item={item} onGone={onGone} t={t} />
        </div>
    );
}
