/**
 * The review a run waits on. A run that asked its owner stops with status
 * `needs_review` and a `review` block; once the owner handled it the block
 * stays, with a `resolution`. Only the first, unresolved one is a question.
 * Keys are the server catalogue's (cowork_review.*), shared with the web.
 */

import type { TranslateFn } from '@/core/i18n';

import type { CoworkReview, CoworkRun, ReviewAction } from './types';

export interface WaitingReview {
    runId: string;
    review: CoworkReview;
}

/** The newest run (the list is newest first) that waits for its owner's answer, if any. */
export function waitingReview(runs: readonly CoworkRun[] | undefined): WaitingReview | null {
    for (const run of runs ?? []) {
        if (run.id && run.status === 'needs_review' && run.review && !run.review.resolution) {
            return { runId: run.id, review: run.review };
        }
    }
    return null;
}

/** An answer needs words; the other two ways of closing a review need none. */
export function canSubmit(action: ReviewAction, answer: string): boolean {
    return action !== 'answer' || answer.trim() !== '';
}

const ACTION_LABELS: Readonly<Record<ReviewAction, readonly [string, string]>> = {
    answer: ['cowork_review.queue.send', 'Send and let the agent continue'],
    done_myself: ['cowork_review.queue.done_myself', 'I did it myself'],
    not_needed: ['cowork_review.queue.not_needed', 'Not needed'],
};

export function actionLabel(action: ReviewAction, t: TranslateFn): string {
    const [key, en] = ACTION_LABELS[action];
    return t(key, en);
}
