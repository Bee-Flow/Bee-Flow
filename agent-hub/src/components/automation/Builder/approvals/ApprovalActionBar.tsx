import { ShieldQuestion, Undo2 } from 'lucide-react';
import ApprovalDecisionControls, { type ApprovalField } from '@/components/admin/Studio/Approvals/ApprovalDecisionControls';
import { decisionOutcome, decisionOutcomeText } from '@/components/admin/Studio/Approvals/decisionOutcome';
import { TestApprovalNote } from '@/components/admin/Studio/Approvals/TestApprovalNote';
import useAutomationApi from '@/hooks/useAutomationApi';
import type { AutomationApiError } from '@/hooks/useAutomationApi';
import { toast } from '@/components/shared/Toast';
import useConfirm from '@/components/shared/useConfirm';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { waitingOnText, type WaitingOn } from '../flow/runPause';

/**
 * Inline action bar for a step that's paused awaiting human approval — the
 * builder-canvas mount of the SAME decision surface the Approvals section
 * uses (ApprovalDecisionControls), so the rules cannot fork: reason required
 * on reject, the snapshot's extra questions answered as part of the decision.
 * The answer is read the same way too (decisionOutcome.ts): a vote, a passed
 * stage, a run that continues, stops, or goes on along its rejected branch.
 *
 * Mounted by the step drawer (approvals/PausedApprovalBar, with the approval
 * row's snapshot) and by Studio's run view. Posts to the owner-scoped
 * approve-step route, which decides for the journey's waiting leg.
 *
 * Props:
 *   runId        — any run of the waiting journey
 *   stepId       — the paused step (kept for the aria/title only)
 *   prompt       — the approval's rendered question
 *   fields       — the approver's extra questions, if any
 *   canDecide    — false: the viewer is not an approver of where it waits;
 *                  the bar says who it waits on and offers Withdraw
 *   waitingOn    — who it waits on (the stage and its seats)
 *   isTest       — a test run's approval: the tester decides for everyone
 *   onFollowRun  — the canvas follows the journey after a decision or a
 *                  withdrawal, so the bar goes away by itself (no second click)
 *   onResolved() — optional callback fired after a successful decision
 */
interface ApprovalActionBarProps {
    runId: string;
    stepId?: string;
    prompt?: unknown;
    fields?: ApprovalField[] | null;
    canDecide?: boolean;
    waitingOn?: WaitingOn | null;
    isTest?: boolean;
    onFollowRun?: ((runId: string) => void) | null;
    onResolved?: (decision: string) => void;
}

const status = (e: unknown) => (e && typeof e === 'object' ? (e as AutomationApiError).status : undefined);

/** A refused decision, in words. A 409 or 410 means the bar was behind the run. */
function decisionErrorText(e: unknown, t: TranslateFn): string {
    const msg = (e as Error)?.message || '';
    if (status(e) === 410 || /expired/i.test(msg)) return t('approvals.toast_expired', 'The deadline for this approval has passed and the run was closed.');
    if (status(e) === 409 || /already/i.test(msg)) return t('approvals.toast_already', 'This approval was already decided.');
    return t('automations.approval_action_bar.toast_failed', 'Could not record the decision: {message}', { message: msg || t('automations.approval_action_bar.unknown_error', 'unknown error') });
}

export default function ApprovalActionBar({
    runId, stepId, prompt, fields = null, canDecide = true, waitingOn = null, isTest = false, onFollowRun = null, onResolved,
}: ApprovalActionBarProps) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const { confirm, confirmDialog } = useConfirm();
    const follow = () => { if (onFollowRun) onFollowRun(runId); };

    const decide = async (decision: string, reason: string | undefined, answers: Record<string, string | boolean> | undefined) => {
        if (!runId) return;
        try {
            // Followed by the canvas: answer as soon as the continuation exists.
            const res = await api.approveStep(runId, decision, reason, answers, onFollowRun ? { respond: 'created' } : {});
            toast.success(decisionOutcomeText(decisionOutcome(res, decision), t, { following: !!onFollowRun }));
            follow();
            onResolved?.(decision);
        } catch (e) {
            toast.error(decisionErrorText(e, t));
            // The run moved on without this bar: let the canvas catch up.
            if (status(e) === 409 || status(e) === 410) follow();
        }
    };

    const withdraw = async () => {
        if (!runId) return;
        const ok = await confirm({
            title: t('approvals.withdraw_confirm', 'Withdraw this approval request? Whoever was asked will be told, and a paused run is closed.'),
            confirmLabel: t('approvals.withdraw', 'Withdraw this request'),
            destructive: true,
        });
        if (!ok) return;
        try {
            await api.cancelRun(runId);
            toast.success(t('approvals.toast_withdrawn', 'Request withdrawn.'));
            follow();
            onResolved?.('withdraw');
        } catch (e) {
            toast.error(t('automations.approval_action_bar.toast_withdraw_failed', 'Could not withdraw the request: {message}', { message: (e as Error)?.message || '' }));
        }
    };

    const question = (typeof prompt === 'string' && prompt.trim())
        ? prompt.trim()
        : t('automations.approval_action_bar.default_question', 'This run is waiting for your decision.');

    return (
        <div className="mx-3 mt-3 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10" data-testid="approval-action-bar">
            <div className="flex items-start gap-2 px-3 py-2">
                <ShieldQuestion size={14} className="mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-amber-700 dark:text-amber-300" data-testid="approval-action-bar-title">
                        {barTitle(canDecide, isTest, waitingOn, t)}
                    </div>
                    <div
                        className="text-[12px] text-[var(--text-primary)] mt-1 whitespace-pre-wrap break-words"
                        title={stepId ? `Step ${stepId}` : undefined}
                    >
                        {question}
                    </div>
                    {canDecide && (
                        <div className="text-[11px] text-[var(--text-secondary)] mt-1">
                            {t('automations.approval_action_bar.approve_and_the_run_continues_from', 'Approve and the run continues from the next step. Reject and the run stops here.')}
                        </div>
                    )}
                </div>
            </div>
            {isTest && canDecide && <div className="px-3 -mt-3 pb-1"><TestApprovalNote approval={{ isTest: true }} /></div>}
            <div className="px-3 pb-2">
                {canDecide ? (
                    <ApprovalDecisionControls fields={fields} onDecide={decide} />
                ) : (
                    <button
                        type="button"
                        onClick={() => { void withdraw(); }}
                        data-testid="approval-action-bar-withdraw"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--border-default)] text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                    >
                        <Undo2 size={12} /> {t('approvals.withdraw', 'Withdraw this request')}
                    </button>
                )}
            </div>
            {confirmDialog}
        </div>
    );
}

/** Whose decision it is: mine (a test's: mine alone), or the stage and people it waits on. */
function barTitle(canDecide: boolean, isTest: boolean, waitingOn: WaitingOn | null, t: TranslateFn): string {
    if (!canDecide) return waitingOnText(waitingOn, t);
    return isTest
        ? t('automations.approval_action_bar.waiting_for_your_decision_test', 'Waiting for your decision (test)')
        : t('automations.approval_action_bar.waiting_for_your_approval', 'Waiting for your approval');
}
