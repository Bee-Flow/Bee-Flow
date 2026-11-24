/**
 * "This is what you would have received", right above the steps of an opened task (./CoworkTaskView.tsx) while its
 * steps wait for their first approval: what the test of exactly these steps produced (GET /api/cowork/:id/plan
 * `triedResult`, server usecases/coworkPlanTryResult.mts), with who it would have gone to. Nothing was sent: it is the
 * test's own output, so the owner approves what they have seen.
 *
 * "Change something" opens What in Settings, where the sentence is; Approve is on the card above (Needs you).
 */
import { recipientWord } from './coworkTaskSendsModel';
import { BTN_QUIET, CARD, CARD_HEAD, META } from './taskUi';
import type { PlanState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The test's result while approval waits; null once the steps are approved, or when the test produced nothing to show. */
function triedResultOf(plan: PlanState | undefined) {
    if (!plan || plan.upToDate) return null;
    return plan.triedResult ?? null;
}

interface CoworkTaskTestedProps {
    plan: PlanState;
    /** Open What in Settings. */
    onChange: () => void;
    t: TranslateFn;
}

export default function CoworkTaskTested({ plan, onChange, t }: CoworkTaskTestedProps) {
    const result = triedResultOf(plan);
    if (!result) return null;
    const to = recipientWord(plan.draft?.recipients?.[result.stepId], t);
    return (
        // motion: ENTER
        <section className={CARD} aria-labelledby="cowork-task-tested-h" data-testid="cowork-task-would-receive">
            <h3 id="cowork-task-tested-h" className={CARD_HEAD}>{t('cowork_task.tested.heading', 'This is what you would have received')}</h3>
            <p className={META}>
                {to
                    ? t('cowork_task.tested.to', 'From the test, on your real data. It would have gone to {who}. Nothing was sent.', { who: to })
                    : t('cowork_task.tested.safe', 'From the test, on your real data. Nothing was sent.')}
            </p>
            <div className="flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2.5">
                {result.title && <span className="text-[14px] font-semibold text-[var(--text-primary)] break-words">{result.title}</span>}
                <p className="m-0 max-h-80 overflow-y-auto text-[14px] leading-[1.55] whitespace-pre-wrap break-words text-[var(--text-primary)]" data-testid="cowork-task-would-receive-text">{result.text}</p>
            </div>
            <div><button type="button" className={BTN_QUIET} onClick={onChange}>{t('cowork_task.tested.change', 'Change something')}</button></div>
        </section>
    );
}
