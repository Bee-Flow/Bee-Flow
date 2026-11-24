/**
 * "This is what you would have received", at the top of an opened task (./CoworkTaskView.tsx) while its steps wait for
 * their approval: what the test of exactly these steps produced (GET /api/cowork/:id/plan `triedResult`, server
 * usecases/coworkPlanTryResult.mts), with who it would have gone to. Nothing was sent: it is the test's own output, so
 * the owner approves what they have seen.
 *
 * The decision is on the card itself: Approve (the steps on screen, by their fingerprint) and "Change something",
 * which opens What in Settings, where the sentence is. The page shows this card in place of the "check the steps"
 * card of Needs you, so there is one place to decide.
 */
import { useQueryClient } from '@tanstack/react-query';
import { ENTER } from '../coworkMotion';
import { recipientWord } from './coworkTaskSendsModel';
import { BTN_PRIMARY, BTN_QUIET, CARD, CARD_HEAD, Failure, META, ROW_ACTIONS } from './taskUi';
import { useCoworkPlanActions } from '@/api/queries/coworkPlan';
import type { PlanState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The test's result while approval waits; null once the steps are approved, or when the test produced nothing to show. */
export function triedResultOf(plan: PlanState | undefined) {
    if (!plan || plan.upToDate) return null;
    return plan.triedResult ?? null;
}

interface CoworkTaskTestedProps {
    coworkId: string;
    plan: PlanState;
    /** The fingerprint of the steps on screen, which approving sends; without one (nothing waits for approval) there is no Approve. */
    fingerprint: string | null;
    /** The steps were approved: one sentence that says so. */
    onApproved: (message: string) => void;
    /** Open What in Settings. */
    onChange: () => void;
    t: TranslateFn;
}

export default function CoworkTaskTested({ coworkId, plan, fingerprint, onApproved, onChange, t }: CoworkTaskTestedProps) {
    const client = useQueryClient();
    const { approve } = useCoworkPlanActions(coworkId);
    const result = triedResultOf(plan);
    if (!result) return null;
    const to = recipientWord(plan.draft?.recipients?.[result.stepId], t);
    const onApprove = (print: string) => approve.mutate(print, {
        // Every Cowork read again: the card under Needs you goes, and the task's status follows.
        onSuccess: async () => {
            await client.invalidateQueries({ queryKey: ['cowork'] });
            onApproved(t('cowork_home.done.approved', 'Approved. It runs by itself from now on.'));
        },
    });
    return (
        <section className={`${CARD} ${ENTER}`} aria-labelledby="cowork-task-tested-h" data-testid="cowork-task-would-receive">
            <h2 id="cowork-task-tested-h" className={`${CARD_HEAD} m-0`}>{t('cowork_task.tested.heading', 'This is what you would have received')}</h2>
            <p className={META}>
                {to
                    ? t('cowork_task.tested.to', 'From the test, on your real data. It would have gone to {who}. Nothing was sent.', { who: to })
                    : t('cowork_task.tested.safe', 'From the test, on your real data. Nothing was sent.')}
            </p>
            <div className="flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2.5">
                {result.title && <span className="text-[14px] font-semibold text-[var(--text-primary)] break-words">{result.title}</span>}
                <p className="m-0 max-h-80 overflow-y-auto text-[14px] leading-[1.55] whitespace-pre-wrap break-words text-[var(--text-primary)]" data-testid="cowork-task-would-receive-text">{result.text}</p>
            </div>
            <div className={ROW_ACTIONS}>
                {fingerprint && <button type="button" className={BTN_PRIMARY} disabled={approve.isPending} onClick={() => onApprove(fingerprint)}>{t('cowork_task.tested.approve', 'Approve')}</button>}
                <button type="button" className={BTN_QUIET} onClick={onChange}>{t('cowork_task.tested.change', 'Change something')}</button>
            </div>
            <Failure error={approve.error} t={t} />
        </section>
    );
}
