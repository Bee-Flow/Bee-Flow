/**
 * The review side of Cowork, in words: which runs wait for the owner, what a refusal by a policy means in plain
 * language, how a handled review reads, and where a run's conversation opens.
 *
 * A run asks for review through its agent's `cowork_request_review` tool (server/core/cowork/reviewTool.mts); the
 * server closes it as `needs_review` with the reason, the question and a summary. The owner answers it (the agent
 * continues in the same conversation, as a follow-up run) or closes it.
 */
import type { TranslateFn } from '../../hooks/useTranslation';
import type { CoworkRun, CoworkRunReview } from '../../api/cowork.types';

/** A run that asked for review and that nobody handled yet. */
export function isWaitingForReview(run: CoworkRun): boolean {
    return run.status === 'needs_review' && !!run.review && !run.review.resolution;
}

const NO_RUNS: CoworkRun[] = [];

export function waitingRuns(runs: CoworkRun[] | null | undefined): CoworkRun[] {
    if (!Array.isArray(runs)) return NO_RUNS;
    return runs.filter(isWaitingForReview);
}

/**
 * Why a policy refused a tool call, in words someone who never saw the policy screen understands. The server stores
 * only the code (server/core/cowork/runActivity.mts REFUSAL_REASONS).
 */
export function refusalReasonText(code: string, t: TranslateFn): string {
    switch (code) {
        case 'privacy_shield':
            return t('cowork_review.reason.privacy_shield', 'Stopped by the Privacy Shield: what the agent wanted to send contained personal data that your organisation does not allow to go to this app.');
        case 'privacy_shield_unavailable':
            return t('cowork_review.reason.privacy_shield_unavailable', 'Stopped by the Privacy Shield: the check for personal data was not available, and your organisation blocks the action until it is.');
        case 'guardrail':
            return t('cowork_review.reason.guardrail', 'Stopped by a guardrail: what the agent wanted to send matched a rule your organisation set.');
        case 'not_offered':
            return t('cowork_review.reason.not_offered', 'Not allowed: this agent may not use this action here.');
        case 'needs_confirmation':
            return t('cowork_review.reason.needs_confirmation', 'Held back: this action asks a person to confirm first, and nobody was there to confirm it.');
        case 'declined':
            return t('cowork_review.reason.declined', 'Declined: a person said no to this action.');
        case 'invalid_arguments':
            return t('cowork_review.reason.invalid_arguments', 'Not run: the agent called it in a way it could not be read.');
        case 'aborted':
            return t('cowork_review.reason.aborted', 'Not run: the run was stopped first.');
        default:
            return t('cowork_review.reason.other', 'Stopped by a policy.');
    }
}

/** "Answered by you on 3 Nov, 10:12" and the like, for a handled review. */
export function resolutionText(review: CoworkRunReview, t: TranslateFn, when: string): string {
    if (review.resolution === 'answered') return t('cowork_review.resolved.answered', 'You answered on {when}; the agent went on in a follow-up run.', { when });
    if (review.resolution === 'done_myself') return t('cowork_review.resolved.done_myself', 'You handled it yourself on {when}.', { when });
    if (review.resolution === 'not_needed') return t('cowork_review.resolved.not_needed', 'You closed it as not needed on {when}.', { when });
    return t('cowork_review.resolved.waiting', 'Waiting for your review.');
}

/**
 * Open the conversation a run wrote into, in the agent's chat. It is kept out of the chat history (it is Cowork's),
 * and this is where it opens: the same event a finished run's notification uses (AgentHub/useDirectChatEvents.ts).
 */
export function openRunConversation(agentId: string, run: CoworkRun, title: string): void {
    if (!run.conversationId) return;
    window.dispatchEvent(new CustomEvent('openDirectChatWithContext', {
        detail: { title, content: run.result || title, agentId, conversationId: run.conversationId, surface: 'cowork' },
    }));
}
