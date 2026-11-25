/**
 * "Target to track", under What in a task's Settings (./TaskSetWhat.tsx): what the task should achieve in one
 * sentence, and the check that counts it after every run (server usecases/coworkGoals.mts). Saving the target has
 * Cowork draft the check; it counts nothing until its owner approves it, and it only ever reads. Public holidays count
 * as working days.
 */
import { useState } from 'react';
import { goalCountText } from '../coworkGoalModel';
import { PART, PART_H } from './taskRows';
import { BTN_QUIET, CARD_SOFT, FIELD, Failure, LABEL, META, ROW_ACTIONS } from './taskUi';
import { useCoworkGoal, type CoworkGoal } from '@/api/coworkGoals';
import type { TranslateFn } from '@/hooks/useTranslation';

/** "Every supplier mail answered within two working days · 46 of 49 this week", for the What row; null without a target. */
export function targetLine(goal: CoworkGoal | null | undefined, t: TranslateFn): string | null {
    if (!goal) return null;
    return t('cowork_task.target.line', 'Target: {sentence} · {count}', { sentence: goal.sentence, count: goalCountText(goal.count, t) });
}

/** Where the check stands, in one line. */
function checkLine(goal: CoworkGoal, t: TranslateFn): string {
    if (!goal.check) return t('cowork_task.goal.no_check', 'Cowork drafts the check that counts it. Nothing is counted until you approve it.');
    if (!goal.check.readsOnly) return t('cowork_task.target.check_not_reads', 'This check would change something, so it cannot be approved. Change the target.');
    if (goal.approved && goal.upToDate) return t('cowork_task.goal.checked', 'The check runs after every run. It only reads, it never changes anything.');
    return t('cowork_task.goal.check_waits', 'The check is ready. It only reads, it never changes anything. Approve it to start counting.');
}

function TargetState({ goal, busy, onApprove, t }: { goal: CoworkGoal; busy: boolean; onApprove: (fingerprint: string) => void; t: TranslateFn }) {
    const check = goal.check;
    const canApprove = !!check && check.readsOnly && !(goal.approved && goal.upToDate);
    return (
        <div className={CARD_SOFT} data-testid="cowork-task-target-state">
            <strong className="font-semibold">{goal.sentence}: {goalCountText(goal.count, t)}</strong>
            <span className={META}>{checkLine(goal, t)}</span>
            {canApprove && check && (
                <div><button type="button" className={BTN_QUIET} disabled={busy} onClick={() => onApprove(check.fingerprint)}>{t('cowork_task.goal.approve', 'Approve the check')}</button></div>
            )}
        </div>
    );
}

export default function TaskSetTarget({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const { query, save, draft, approve, remove } = useCoworkGoal(coworkId);
    const goal = query.data ?? null;
    const [typed, setTyped] = useState<string | null>(null);
    const sentence = typed ?? goal?.sentence ?? '';
    const busy = [save, draft, approve, remove].some((m) => m.isPending);
    const error = [save, draft, approve, remove].find((m) => m.error)?.error ?? null;
    const trimmed = sentence.trim();
    const saveTarget = async () => {
        await save.mutateAsync({ sentence: trimmed, targetPercent: goal?.targetPercent ?? 100 });
        await draft.mutateAsync();
    };
    const fieldId = `cowork-task-target-${coworkId}`;
    return (
        <div className={PART} data-testid="cowork-task-target">
            <span className={PART_H}>{t('cowork_task.target.heading', 'Target to track')}</span>
            <div className="flex flex-col gap-1">
                <label htmlFor={fieldId} className={LABEL}>{t('cowork_task.goal.label', 'What should this task achieve? One sentence.')}</label>
                <input id={fieldId} type="text" className={FIELD} maxLength={500} value={sentence} onChange={(e) => setTyped(e.target.value)} placeholder={t('cowork_task.goal.placeholder', 'Every supplier mail answered within two working days')} />
            </div>
            {goal && <TargetState goal={goal} busy={busy} onApprove={(fp) => approve.mutate(fp)} t={t} />}
            <p className={META}>{t('cowork_task.goal.holidays', 'Working days are Monday to Friday. Public holidays count as working days.')}</p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_QUIET} disabled={busy || !trimmed || goal?.sentence === trimmed} onClick={() => { saveTarget().catch(() => undefined); }}>
                    {draft.isPending ? t('cowork_task.goal.drafting', 'Drafting the check…') : t('cowork_task.target.save', 'Save target')}
                </button>
                {goal && <button type="button" className={BTN_QUIET} disabled={busy} onClick={() => remove.mutate(undefined, { onSuccess: () => { setTyped(''); draft.reset(); } })}>{t('cowork_task.target.remove', 'Remove target')}</button>}
            </div>
            <Failure error={error} t={t} />
        </div>
    );
}
