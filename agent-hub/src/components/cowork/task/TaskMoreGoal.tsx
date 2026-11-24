/**
 * "Goal", a row of More in an opened task (./CoworkTaskMore.tsx): what the task should achieve in one sentence, and
 * the check that counts it after every run (server usecases/coworkGoals.mts). Saving the goal has Cowork draft the
 * check; it counts nothing until its owner approves it, and it only ever reads. Public holidays count as working days.
 */
import { useState } from 'react';
import { goalCountText } from '../coworkGoalModel';
import { BTN_PRIMARY, BTN_QUIET, CARD_SOFT, FIELD, Failure, FoldRow, LABEL, META, ROW_ACTIONS } from './taskUi';
import { useCoworkGoal, type CoworkGoal } from '@/api/coworkGoals';
import type { TranslateFn } from '@/hooks/useTranslation';

interface RowProps { coworkId: string; open: boolean; onToggle: (id: string | null) => void; t: TranslateFn }

/** Where the check stands, in one line. */
function checkLine(goal: CoworkGoal, t: TranslateFn): string {
    if (!goal.check) return t('cowork_task.goal.no_check', 'Cowork drafts the check that counts it. Nothing is counted until you approve it.');
    if (!goal.check.readsOnly) return t('cowork_task.goal.check_not_reads', 'This check would change something, so it cannot be approved. Change the goal.');
    if (goal.approved && goal.upToDate) return t('cowork_task.goal.checked', 'The check runs after every run. It only reads, it never changes anything.');
    return t('cowork_task.goal.check_waits', 'The check is ready. It only reads, it never changes anything. Approve it to start counting.');
}

function GoalState({ goal, busy, onApprove, t }: { goal: CoworkGoal; busy: boolean; onApprove: (fingerprint: string) => void; t: TranslateFn }) {
    const check = goal.check;
    const canApprove = !!check && check.readsOnly && !(goal.approved && goal.upToDate);
    return (
        <div className={CARD_SOFT} data-testid="cowork-task-goal-state">
            <strong>{goal.sentence}: {goalCountText(goal.count, t)}</strong>
            <span className={META}>{checkLine(goal, t)}</span>
            {canApprove && check && (
                <div><button type="button" className={BTN_QUIET} disabled={busy} onClick={() => onApprove(check.fingerprint)}>{t('cowork_task.goal.approve', 'Approve the check')}</button></div>
            )}
        </div>
    );
}

function GoalBody({ coworkId, goal, t }: { coworkId: string; goal: CoworkGoal | null; t: TranslateFn }) {
    const { save, draft, approve, remove } = useCoworkGoal(coworkId);
    const [sentence, setSentence] = useState(goal?.sentence ?? '');
    const busy = [save, draft, approve, remove].some((m) => m.isPending);
    const error = [save, draft, approve, remove].find((m) => m.error)?.error ?? null;
    const trimmed = sentence.trim();
    const saveGoal = async () => {
        await save.mutateAsync({ sentence: trimmed, targetPercent: goal?.targetPercent ?? 100 });
        await draft.mutateAsync();
    };
    const fieldId = `cowork-task-goal-${coworkId}`;
    return (
        <>
            <div className="flex flex-col gap-1.5">
                <label htmlFor={fieldId} className={LABEL}>{t('cowork_task.goal.label', 'What should this task achieve? One sentence.')}</label>
                <input id={fieldId} type="text" className={FIELD} maxLength={500} value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder={t('cowork_task.goal.placeholder', 'Every supplier mail answered within two working days')} />
            </div>
            {goal && <GoalState goal={goal} busy={busy} onApprove={(fp) => approve.mutate(fp)} t={t} />}
            <p className={META}>{t('cowork_task.goal.holidays', 'Working days are Monday to Friday. Public holidays count as working days.')}</p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_PRIMARY} disabled={busy || !trimmed || goal?.sentence === trimmed} onClick={() => { saveGoal().catch(() => undefined); }}>
                    {draft.isPending ? t('cowork_task.goal.drafting', 'Drafting the check…') : t('cowork_task.goal.save', 'Save goal')}
                </button>
                {goal && <button type="button" className={BTN_QUIET} disabled={busy} onClick={() => remove.mutate(undefined, { onSuccess: () => setSentence('') })}>{t('cowork_task.goal.remove', 'Remove goal')}</button>}
            </div>
            <Failure error={error} t={t} />
        </>
    );
}

export default function TaskMoreGoal({ coworkId, open, onToggle, t }: RowProps) {
    const goal = useCoworkGoal(coworkId).query.data ?? null;
    return (
        <FoldRow id="goal" label={t('cowork_task.more.goal', 'Goal')} value={goal ? goalCountText(goal.count, t) : t('cowork_task.more.none', 'None')} open={open} onToggle={onToggle}>
            <GoalBody coworkId={coworkId} goal={goal} t={t} />
        </FoldRow>
    );
}
