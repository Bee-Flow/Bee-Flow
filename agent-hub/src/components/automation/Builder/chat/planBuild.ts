/**
 * Which plan the builder is working through right now.
 *
 * After "Build this plan" the work mode is that plan until it is done: every
 * follow-up ("continue", "fix X", an answer to a question) belongs to it, and
 * the composer says so. The server owns the lifecycle (review, building, paused,
 * built); `building` and `paused` are the two states in which the plan is still
 * open. Once it is `built` the user's own work mode applies again.
 */

export interface ReviewPlanLike {
    id?: string | null;
    version?: number | string | null;
    status?: string | null;
    pauseAfterStep?: boolean | null;
}

export function isPlanStatusInProgress(status: string | null | undefined): boolean {
    return status === 'building' || status === 'paused';
}

export function isPlanInProgress(plan: ReviewPlanLike | null | undefined): boolean {
    return !!plan?.id && isPlanStatusInProgress(plan.status);
}

/** The id to send as `approvedPlanId` with a follow-up message, or null. */
export function inProgressPlanId(plan: ReviewPlanLike | null | undefined): string | null {
    return isPlanInProgress(plan) ? (plan?.id ?? null) : null;
}

/**
 * The plan a message the user sends now belongs to, or null for a fresh plan
 * turn. A follow-up during an open build continues it, and so does the answer to
 * a question the build itself asked: without the id the server would start a new
 * plan turn, which is exactly the loop the questions caused before.
 */
export function followUpPlanId({ plan, questionsPlanId = null, answering = false }: {
    plan: ReviewPlanLike | null | undefined;
    questionsPlanId?: string | null;
    answering?: boolean;
}): string | null {
    if (isPlanInProgress(plan)) return plan?.id ?? null;
    if (answering && plan?.id && questionsPlanId === plan.id && plan.status !== 'built') return plan.id;
    return null;
}
