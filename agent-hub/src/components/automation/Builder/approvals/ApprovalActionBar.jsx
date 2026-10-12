import { ShieldQuestion } from 'lucide-react';
import React from 'react';
import ApprovalDecisionControls from '../../../admin/Studio/Approvals/ApprovalDecisionControls';
import useAutomationApi from '../../../../hooks/useAutomationApi';
import { toast } from '../../../shared/Toast';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * Inline action bar for a step that's paused awaiting human approval — the
 * builder-canvas mount of the SAME decision surface the Approvals section
 * uses (ApprovalDecisionControls), so the rules cannot fork: reason required
 * on reject, the snapshot's extra questions answered as part of the decision.
 *
 * Lives inside StepInspector, above the SettingsForm, so the user sees the
 * decision affordance the moment they click the paused node. Posts to the
 * legacy owner-scoped route; the Approvals section posts to its own.
 *
 * Props:
 *   runId        — the awaiting run's id (from runStep.runId)
 *   stepId       — the paused step (kept for the aria/title only)
 *   prompt       — the approval's rendered question (runStep.output.prompt,
 *                  falling back to the definition's raw prompt)
 *   fields       — the step's declared approver questions, if any
 *   onResolved() — optional callback fired after a successful decision
 */
export default function ApprovalActionBar({ runId, stepId, prompt, fields = null, onResolved }) {
    const { t } = useTranslation();
    const api = useAutomationApi();

    const decide = async (decision, reason, answers) => {
        if (!runId) return;
        try {
            await api.approveStep(runId, decision, reason, answers);
            toast.success(decision === 'approve'
                ? 'Approved — the run is continuing.'
                : 'Rejected — the run has stopped.');
            onResolved?.(decision);
        } catch (e) {
            const msg = e?.message || 'unknown error';
            if (/410|expired/i.test(msg)) {
                toast.error('The deadline for this approval has passed and the run was closed.');
            } else if (/409|already/i.test(msg)) {
                toast.error('This approval was already decided.');
            } else {
                toast.error(`Couldn't ${decision} the run: ${msg}`);
            }
        }
    };

    const question = (typeof prompt === 'string' && prompt.trim())
        ? prompt.trim()
        : 'This run is waiting for your decision.';

    return (
        <div className="mx-3 mt-3 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10">
            <div className="flex items-start gap-2 px-3 py-2">
                <ShieldQuestion size={14} className="mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-amber-700 dark:text-amber-300">
                        {t('automations.approval_action_bar.waiting_for_your_approval', 'Waiting for your approval')}
                    </div>
                    <div
                        className="text-[12px] text-[var(--text-primary)] mt-1 whitespace-pre-wrap break-words"
                        title={stepId ? `Step ${stepId}` : undefined}
                    >
                        {question}
                    </div>
                    <div className="text-[11px] text-[var(--text-secondary)] mt-1">
                        {t('automations.approval_action_bar.approve_and_the_run_continues_from', 'Approve and the run continues from the next step. Reject and the run stops here.')}
                    </div>
                </div>
            </div>
            <div className="px-3 pb-2">
                <ApprovalDecisionControls fields={fields} onDecide={decide} />
            </div>
        </div>
    );
}
