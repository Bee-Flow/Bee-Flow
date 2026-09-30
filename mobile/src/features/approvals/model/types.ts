/**
 * One decision waiting on a person.
 *
 * A paused automation (`source: 'run'`, where approving resumes the run) or an
 * App Studio request (`source: 'app'`, where the decision IS the outcome and
 * there is no run behind it). The distinction matters on a phone: the first
 * has somewhere to go afterwards and the second does not.
 *
 * Shape from server/stores/automationStore/approvals.js `rowToApproval`,
 * narrowed to what a phone actually renders — the panel/stage machinery is
 * summarised by the server into `canDecide`, so the client never has to
 * reimplement quorum rules it could get wrong.
 */
export interface Approval {
    id: string;
    automationId: string | null;
    automationTitle: string;
    projectTitle: string;
    runId: string | null;
    stepId: string | null;
    source: 'run' | 'app' | string;
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | string;
    prompt: string;
    detailsMd: string | null;
    context: Record<string, unknown> | null;
    decidedByName: string | null;
    decisionReason: string | null;
    decidedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
}

export interface ApprovalDetail {
    approval: Approval;
    /**
     * Whether this viewer can act RIGHT NOW — not merely whether they hold a
     * seat. The server resolves stages, quorum and votes-already-cast into
     * this one boolean precisely so a client cannot get it wrong.
     */
    canDecide: boolean;
    canWithdraw: boolean;
}

export type ApprovalDecision = 'approve' | 'reject';

/**
 * Which list the inbox shows: what is waiting on me, everything I take part
 * in, or — for an organisation administrator — the whole organisation's.
 */
export type ApprovalScope = 'pending' | 'all' | 'org';
