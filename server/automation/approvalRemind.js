'use strict';

/**
 * "Send reminder" on a run that waits on an approval (handoff 5, Runs tab):
 * POST /api/automation/approvals/:id/remind.
 *
 * Who may press it: the people on the ASKING side of the approval.
 *   - the approval's owner (whose automation asked),
 *   - an org admin of the approval's organisation,
 *   - anyone who may read every run of the automation (role view and up), and
 *   - a run-only member for a run they started themselves.
 * An assignee who only DECIDES has nothing to remind anyone of: they get 403.
 * Anybody who cannot see the approval at all gets the same 404 as a missing
 * one, so an id is never an oracle.
 *
 * The reminder goes to exactly the people the scheduled reminder would reach
 * (approvalLifecycle.reminderRecipientIds), through the same notification
 * path. At most one per approval per 10 minutes (the store's claim).
 */

const { HttpError } = require('../core/http/errors');

/**
 * @param {{
 *   store: {
 *     getApproval: (id: string) => Promise<any>,
 *     getRun?: (id: string) => Promise<any>,
 *     getAutomation?: (id: string) => Promise<any>,
 *     claimApprovalReminder: (id: string, opts: object) => Promise<any>,
 *   },
 *   canView: (approval: any, viewer: any) => boolean,
 *   roleFor: (automation: any, userId: string, opts?: object) => Promise<{ role: string|null }>,
 *   sendReminder: (approval: any) => Promise<string[]>,
 *   windowMinutes?: number,
 * }} deps
 */
function makeApprovalReminder(deps) {
    const { store, canView, roleFor, sendReminder } = deps;
    const windowMinutes = deps.windowMinutes || 10;

    async function mayRemind(approval, viewer, session) {
        if (approval.ownerId && approval.ownerId === viewer.userId) return true;
        if (approval.organizationId && viewer.isOrgAdminOfOrg?.(approval.organizationId)) return true;
        if (!approval.automationId || !store.getAutomation) return false;
        const automation = await store.getAutomation(approval.automationId).catch(() => null);
        if (!automation) return false;
        const { role } = await roleFor(automation, viewer.userId, { session }).catch(() => ({ role: null }));
        if (role === 'owner' || role === 'edit' || role === 'view') return true;
        if (role === 'run' && approval.runId && store.getRun) {
            // A run-only member reminds for the runs they started. The
            // approval sits on the leg that paused; the person is on the head.
            const leg = await store.getRun(approval.runId).catch(() => null);
            const head = leg && leg.rootRunId && leg.rootRunId !== leg.id
                ? await store.getRun(leg.rootRunId).catch(() => null)
                : leg;
            return [leg, head].some(r => r && (r.startedByUserId === viewer.userId || r.submittedByUserId === viewer.userId));
        }
        return false;
    }

    /**
     * @param {{ approvalId: string, viewer: { userId: string, isOrgAdminOfOrg?: Function }, session?: any }} p
     * @returns {Promise<{ reminded: true, remindedAt: string, nextAllowedAt: string, recipients: number }>}
     */
    async function remind({ approvalId, viewer, session = null }) {
        if (!viewer?.userId) throw new HttpError(401, 'unauthorized', 'Not signed in');
        const approval = await store.getApproval(approvalId);
        const asking = approval ? await mayRemind(approval, viewer, session) : false;
        if (!approval || (!asking && !canView(approval, viewer))) {
            throw new HttpError(404, 'approval_not_found', 'Approval not found');
        }
        if (!asking) {
            throw new HttpError(403, 'approval_remind_forbidden', 'Only the people who asked for this approval can send a reminder.');
        }
        if (approval.status !== 'pending') {
            throw new HttpError(409, 'approval_not_pending', 'This approval has already been decided, so there is nobody to remind.');
        }
        const claim = await store.claimApprovalReminder(approval.id, { byUserId: viewer.userId, windowMinutes });
        if (!claim.claimed && claim.reason === 'not_pending') {
            throw new HttpError(409, 'approval_not_pending', 'This approval has already been decided, so there is nobody to remind.');
        }
        if (!claim.claimed) {
            const retryAfterSec = Math.max(1, Math.ceil((new Date(claim.nextAt).getTime() - Date.now()) / 1000));
            throw new HttpError(429, 'remind_rate_limited', `A reminder was sent less than ${windowMinutes} minutes ago.`, {
                lastRemindedAt: claim.lastAt,
                nextAllowedAt: claim.nextAt,
                retryAfterSec,
            });
        }
        const recipients = await sendReminder(approval);
        return {
            reminded: true,
            remindedAt: claim.at,
            nextAllowedAt: new Date(new Date(claim.at).getTime() + windowMinutes * 60_000).toISOString(),
            recipients: Array.isArray(recipients) ? recipients.length : 0,
        };
    }

    return { remind, mayRemind };
}

module.exports = { makeApprovalReminder };
