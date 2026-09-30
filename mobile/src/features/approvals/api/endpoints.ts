/**
 * The approvals endpoints, under /api/automation/approvals.
 *
 * The LIST route sits behind requireModule('approvals'); DECIDING one
 * deliberately does not, so a person can always answer what is waiting on
 * them even when their plan hides the inbox.
 */

import { api } from '@/core/api/client';
import { field, nullable, pick } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import { readApproval, readApprovalDetail } from './readers';
import type { Approval, ApprovalDecision, ApprovalDetail, ApprovalScope } from '../model/types';

const path = (id: string) => `/api/automation/approvals/${encodeURIComponent(id)}`;

/**
 * The approvals waiting on this person (`pending`), every one they take part
 * in (`all`), or the organisation's (`org`, an org-admin role only).
 *
 *
 * `mobile/` had `getApproval` and `decideApproval` but no way to LIST them, so
 * `app/approvals/[id].tsx` could only ever be opened by tapping an unread
 * notification — and once that notification was gone, a decided approval had no
 * door at all, and a pending one had none either.
 *
 * `scope=mine` by default: the org scope needs an org-admin role and 403s
 * otherwise, and "what is waiting on ME" is the phone question. `org` is the
 * web's Organisation switch, offered to an organisation administrator.
 */
export async function listApprovals(
    status: ApprovalScope = 'pending',
    signal?: AbortSignal,
): Promise<Approval[]> {
    const res = await api.get<unknown>('/api/automation/approvals', {
        query: { scope: status === 'org' ? 'org' : 'mine', ...(status === 'pending' ? { status: 'pending' } : {}) },
        signal,
    });
    return withId(field.list(readApproval)(pick(res, 'approvals')));
}

/**
 * One approval by id.
 *
 * Keyed by APPROVAL id, not run id, because that is what a notification link
 * carries (`/app/studio/approvals/:id` — server/automation/approvalHooks.js)
 * and because an App Studio approval has no run at all. The run-keyed
 * `decideRunStep` (features/automations) cannot serve a notification for
 * either reason.
 *
 * A missing approval and one belonging to somebody else both answer 404 by
 * design: an approval id must not be an oracle for what exists in another
 * organisation.
 */
export async function getApproval(id: string, signal?: AbortSignal): Promise<ApprovalDetail | null> {
    return nullable(readApprovalDetail)(await api.get<unknown>(path(id), { signal }));
}

/**
 * Decide an approval by its own id.
 *
 * Distinct from `decideRunStep`: this route resolves panel seats, stage chains
 * and quorum server-side, so it is the only correct way to decide anything
 * that is not a plain single-assignee run pause.
 */
export async function decideApproval(
    id: string,
    decision: ApprovalDecision,
    reason?: string,
): Promise<void> {
    await api.post(
        `${path(id)}/decide`,
        { decision, ...(reason ? { reason } : {}) },
        { retry: false },
    );
}
