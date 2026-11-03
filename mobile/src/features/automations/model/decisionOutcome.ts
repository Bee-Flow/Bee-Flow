/**
 * What a decision came to, in words: the run screen's Approve/Reject and the
 * approvals screen both say it from the server's answer (api/readers.ts
 * readRunDecisionResult), never from the button that was pressed. On a panel
 * or a stage chain the answer is a vote and the run keeps waiting; saying
 * "Approved" there would be a false success.
 *
 * And where Approve has to go instead of posting: an approval that asks for
 * answers is decided on the approvals screen, which asks for them (a post
 * without them is refused with a 400).
 */

import type { TranslateFn } from '@/core/i18n';

import type { RunDecisionResult, RunPendingApproval } from './types';

export interface DecisionOutcome {
    text: string;
    tone: 'success' | 'neutral';
}

function voteText(stage: string | null, t: TranslateFn): string {
    if (stage === 'final') return t('mobile.runs.decision.vote_final', 'Your vote is recorded. It now waits for the final approver.');
    if (stage) return t('mobile.runs.decision.vote_next_stage', 'Your vote is recorded. It moved to the next stage.');
    return t('mobile.runs.decision.vote_waiting', 'Your vote is recorded. It still waits for the others.');
}

export function decisionOutcome(result: RunDecisionResult, t: TranslateFn): DecisionOutcome {
    if (result.kind === 'vote') return { text: voteText(result.stage, t), tone: 'neutral' };
    if (result.decision === 'reject') {
        return result.kind === 'pending'
            ? { text: t('mobile.runs.decision.rejected_branch', 'Rejected. The run continues on its rejected branch.'), tone: 'success' }
            : { text: t('approvals.verb_rejected', 'Rejected'), tone: 'success' };
    }
    return result.kind === 'pending'
        ? { text: t('mobile.runs.decision.approved_pending', 'Approved. The run continues.'), tone: 'success' }
        : { text: t('mobile.runs.decision.approved_done', 'Approved. The run carried on.'), tone: 'success' };
}

/** Display-only field types: they ask nothing (formTriggerContract DISPLAY types). */
const SHOWS_ONLY = new Set(['info', 'download', 'notebook']);

/** True when approving asks for answers: some field of the snapshot takes input. */
export function approvalNeedsAnswers(pending: Pick<RunPendingApproval, 'fields'> | null | undefined): boolean {
    return !!pending?.fields.some((f) => !SHOWS_ONLY.has(String(f?.type ?? 'text')));
}

/** Where Approve goes for an approval that asks for answers: the approvals screen, its sheet open. Null: post here. */
export function approveRoute(pending: RunPendingApproval | null | undefined): string | null {
    if (!pending || !approvalNeedsAnswers(pending)) return null;
    return `/approvals/${encodeURIComponent(pending.approvalId)}?decide=approve`;
}
