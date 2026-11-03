import { FlaskConical, Hourglass } from 'lucide-react';
import React, { useState } from 'react';
import ApprovalDecisionControls from '../../admin/Studio/Approvals/ApprovalDecisionControls';
import { FormRichText } from '../../forms/PublicFormRenderer';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import { phaseLabel } from './FormRunPhases';
import type { PendingApproval } from './formRunApi';

/**
 * The journey waits on an approval: a pause, never an error (RUN-01, pauses F2).
 *
 * The questions are the approval row's SNAPSHOT (GET /runs/:id/form
 * pendingApproval), so they are the ones the approver is asked, not the
 * definition as it is being edited. Who may decide is the server's answer
 * (canDecide): in a test run always the tester, who decides for every approver
 * the step names (the sandbox seat). Anybody else sees who it waits on and may
 * withdraw it, which ends the run.
 */
interface FormRunApprovalProps {
    approval: PendingApproval | null;
    onDecide: (decision: string, reason?: string, answers?: unknown) => Promise<void>;
    onWithdraw: () => Promise<void>;
}

function waitingText(t: TranslateFn, approval: PendingApproval): string {
    const stage = approval.waitingOn?.stageName;
    const count = Math.max(1, Number(approval.waitingOn?.seatCount) || 1);
    if (stage) return t('automation_testing.overlay.waiting_for_stage', 'Waiting for {stage} ({count})', { stage, count });
    if (count > 1) return t('automation_testing.overlay.waiting_for_people', 'Waiting for {count} approvers', { count });
    return t('automation_testing.overlay.waiting_for_approver', 'Waiting for the approver');
}

function WaitingOnOthers({ approval, onWithdraw }: { approval: PendingApproval; onWithdraw: () => Promise<void> }) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const withdraw = async () => {
        setBusy(true);
        setError(null);
        try { await onWithdraw(); } catch (e) { setError(messageOf(e, t('automation_testing.overlay.withdraw_failed', 'The approval could not be withdrawn.'))); } finally { setBusy(false); }
    };
    return (
        <div className="flex flex-col items-start gap-2">
            <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                <Hourglass size={12} aria-hidden="true" />
                {waitingText(t, approval)}
            </p>
            <button
                type="button"
                onClick={withdraw}
                disabled={busy}
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
                {t('automation_testing.overlay.withdraw', 'Withdraw')}
            </button>
            {error && <p role="alert" className="text-xs text-[var(--error)]">{error}</p>}
        </div>
    );
}

export default function FormRunApproval({ approval, onDecide, onWithdraw }: FormRunApprovalProps) {
    const { t } = useTranslation();
    const [error, setError] = useState<string | null>(null);
    const decide = async (decision: string, reason?: string, answers?: unknown) => {
        setError(null);
        try { await onDecide(decision, reason, answers); } catch (e) { setError(messageOf(e, t('automation_testing.overlay.decide_failed', 'The decision could not be sent.'))); }
    };
    return (
        <div className="space-y-3 text-left" data-testid="form-run-approval">
            <p className="text-sm font-medium text-[var(--text-primary)]">{phaseLabel(t, 'paused_approval')}</p>
            {!approval && (
                <p className="text-xs text-[var(--text-secondary)]">
                    {t('automation_testing.overlay.approval_elsewhere', 'The run waits for a decision. Decide it on the canvas or in Approvals.')}
                </p>
            )}
            {approval?.prompt && <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap">{approval.prompt}</p>}
            {approval?.detailsMd && <FormRichText className="text-xs text-[var(--text-secondary)]">{approval.detailsMd}</FormRichText>}
            {approval?.isTest && (
                <p className="flex items-start gap-2 rounded-lg bg-violet-500/10 px-2.5 py-2 text-xs text-[var(--text-secondary)]">
                    <FlaskConical size={13} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
                    {t('approvals.test_decision', 'Test decision: you decide for every approver.')}
                </p>
            )}
            {approval?.canDecide && <ApprovalDecisionControls key={approval.approvalId} fields={approval.fields ?? null} onDecide={decide} />}
            {approval && !approval.canDecide && <WaitingOnOthers approval={approval} onWithdraw={onWithdraw} />}
            {error && <p role="alert" className="text-xs text-[var(--error)]">{error}</p>}
        </div>
    );
}
