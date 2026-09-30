/**
 * An approval's state and its clock, in the web's words
 * (agent-hub Studio/Approvals/approvalDisplay.js and ApprovalDetail.jsx).
 *
 * The phone used to print the server's own token — "rejected", "cancelled" —
 * in English whatever the language, where the web says "Declined" and
 * "Closed" under keys an administrator has already translated. And it said a
 * deadline with the relative-age helper, which turned a week from now into
 * "now".
 */

import { formatWhen, type TranslateFn } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';

import type { Approval } from './types';

/** The status word (the web's `approvals.status_*`); a status it does not know reads as itself, humanised. */
export function approvalStatusLabel(status: string, t: TranslateFn): string {
    switch (status) {
        case 'pending':
            return t('approvals.status_pending', 'Waiting');
        case 'approved':
            return t('approvals.status_approved', 'Approved');
        case 'rejected':
            return t('approvals.status_rejected', 'Declined');
        case 'expired':
            return t('approvals.status_expired', 'Expired');
        case 'cancelled':
            return t('approvals.status_cancelled', 'Closed');
        default:
            return humanise(status);
    }
}

/**
 * ApprovalDetail.jsx's clock line: a waiting approval says its deadline (or
 * that it has none), a settled one when it was asked. A deadline is a date,
 * never an age.
 */
export function approvalWhenLine(
    approval: Pick<Approval, 'status' | 'expiresAt' | 'createdAt'>,
    t: TranslateFn,
    now = Date.now(),
): string {
    if (approval.status === 'pending') {
        return approval.expiresAt
            ? `${t('approvals.decide_before_cap', 'Decide before')} ${formatWhen(approval.expiresAt, now)}`
            : t('approvals.no_deadline', 'No deadline');
    }
    return `${t('approvals.requested', 'Requested')} ${formatWhen(approval.createdAt, now)}`;
}
