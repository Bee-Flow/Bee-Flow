import { FlaskConical } from 'lucide-react';
import { productionRouteText, type ApprovalRowLike } from './approvalDisplay';
import useTranslation from '@/hooks/useTranslation';

/**
 * A test or dry run's approval (the sandbox seat): the person who started the
 * run decides alone, for every approver the step names. The list row and the
 * detail header wear the chip; the detail adds the note with the route a
 * production run would take.
 */
export function TestChip({ className = '' }: { className?: string }) {
    const { t } = useTranslation();
    return (
        <span
            className={`shrink-0 inline-flex items-center rounded-full px-1.5 py-px text-[10px] uppercase tracking-wide font-medium bg-violet-500/15 text-violet-700 dark:text-violet-300 ${className}`}
            data-testid="approval-test-chip"
        >
            {t('approvals.test_chip', 'Test')}
        </span>
    );
}

export function TestApprovalNote({ approval }: { approval: ApprovalRowLike }) {
    const { t } = useTranslation();
    if (!approval.isTest) return null;
    const route = productionRouteText(approval, t);
    return (
        <div className="mt-5 flex items-start gap-2.5 rounded-xl bg-violet-500/10 px-3 py-2.5 text-[12.5px] text-[var(--text-secondary)]">
            <FlaskConical size={14} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
            <div className="space-y-0.5">
                <div className="font-medium text-[var(--text-primary)]">
                    {t('approvals.test_decision', 'Test decision: you decide for every approver.')}
                </div>
                {route && <div>{route}</div>}
            </div>
        </div>
    );
}
