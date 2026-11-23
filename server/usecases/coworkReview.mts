/**
 * A Cowork run that asked its owner to review (`cowork_request_review`, core/cowork/reviewTool.mts), handled from
 * Cowork (POST /api/cowork/:id/runs/:runId/review, routes/cowork.js, which checked the item is the caller's):
 *
 *   - 'done_myself' / 'not_needed': the run is closed as handled, nothing runs;
 *   - 'answer': the run is closed as answered and a FOLLOW-UP run continues the work with the owner's answer, in the
 *     SAME conversation, as the same agent, with the same tool policy as the run it continues:
 *       - its tool stack is capped at the tools that run was offered (`toolCeiling`, core/cowork/runActivity.mts):
 *         a follow-up never gets a tool the original run did not have, also when the agent was given more since;
 *       - a mail run keeps its mail-run policy (`mailTrigger` metadata: the allow-list, the reply in the same thread
 *         only, drafts instead of a send when it read outside the thread) and stays unattended;
 *       - at most COWORK_REVIEW_MAX_FOLLOWUPS answers deep (default 5, 0 = unlimited): a run that keeps asking is
 *         closed by hand, not continued forever.
 *
 * Handling is once only (stores/coworkReviews.mts): a second click on a run already handled is a 409.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { envInt } = nodeRequire('../utils/envNumber.mts') as { envInt: (name: string, d: number, b?: { min?: number }) => number };
const log = nodeRequire('../telemetry/log.js') as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

export const MAX_FOLLOWUPS_ENV = 'COWORK_REVIEW_MAX_FOLLOWUPS';
export const DEFAULT_MAX_FOLLOWUPS = 5;
export const MAX_ANSWER_CHARS = 4000;

export type ReviewAction = 'answer' | 'done_myself' | 'not_needed';

type Review = { reason: string; question: string | null; summary: string | null; resolution: string | null };
type MailContext = { provider: 'gmail' | 'outlook'; messageId: string; threadId?: string | null; mailbox?: string | null; readOutside?: boolean };
type RunContext = { offeredTools?: unknown; unattended?: boolean; mail?: MailContext | null } | null;
type ReviewRun = {
    id: string; status: string; followupDepth?: number; conversationId?: string | null; mailSubject?: string | null;
    review: Review | null; runContext: RunContext;
};
type Schedule = { id: string; userId: string; agentId?: string | null; title?: string; prompt?: string; lastStatus?: string | null } & Record<string, unknown>;

export type Deps = {
    store: {
        getRunForReview: (scheduleId: string, runId: string) => Promise<ReviewRun | null>;
        resolveReview: (p: { scheduleId: string; runId: string; userId: string; resolution: string; followUp: boolean }) =>
            Promise<{ run: Record<string, unknown> | null; followUpRunId: string | null } | null>;
    };
    /** Start the follow-up in the background (it can take minutes); never awaited by the request. */
    startRun: (task: Schedule, trigger: Record<string, unknown>) => void;
    fetchMessage?: (p: { provider: 'gmail' | 'outlook'; userId: string; messageId: string; mailbox: string | null }) => Promise<Record<string, unknown> | null>;
};

function defaultDeps(): Deps {
    return {
        store: nodeRequire('../stores/coworkStore.js'),
        startRun: (task, trigger) => {
            setImmediate(() => {
                // Through executeCowork like every start: a read-only organisation or a spent budget refuses it too.
                nodeRequire('../core/cowork/coworkRunner.js').executeCowork(task, { trigger })
                    .catch((e: Error) => log.error(`[Cowork] follow-up run of ${task.id} failed to start: ${e.message}`));
            });
        },
    };
}

/** How many answers deep a follow-up may go; Infinity for 0 (unlimited). */
export function maxFollowUps(): number {
    const n = envInt(MAX_FOLLOWUPS_ENV, DEFAULT_MAX_FOLLOWUPS, { min: 0 });
    return n === 0 ? Infinity : n;
}

/** The follow-up's prompt: the review it answers and the owner's answer, inside the conversation of the run. */
export function buildFollowUpPrompt(taskPrompt: string, review: Review | null, answer: string): string {
    return [
        'The owner of this Cowork item answered the review you asked for in the previous run.',
        review?.reason ? `Your reason was: ${review.reason}` : '',
        review?.question ? `Your question was: ${review.question}` : '',
        '',
        'Their answer:',
        answer,
        '',
        'Continue the task in this conversation with that answer. The task is:',
        taskPrompt.trim(),
        '',
        'If you still need a decision only they can make, call cowork_request_review again.',
    ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n');
}

function refuseUnlessWaiting(run: ReviewRun | null): ReviewRun {
    if (!run) throw new HttpError(404, 'run_not_found', 'This run is not part of this Cowork item.');
    if (run.status !== 'needs_review' || !run.review || run.review.resolution) {
        throw new HttpError(409, 'review_not_open', 'This run is not waiting for a review.');
    }
    return run;
}

function assertCanContinue(schedule: Schedule, run: ReviewRun, answer: string): string[] {
    if (!answer) throw new HttpError(400, 'answer_required', 'Write the answer or instruction the agent should continue with.');
    if (!schedule.agentId || !run.conversationId) {
        throw new HttpError(409, 'review_followup_unavailable', 'This run cannot be continued: it ran without an agent conversation.');
    }
    const offered = run.runContext?.offeredTools;
    if (!Array.isArray(offered)) {
        throw new HttpError(409, 'review_followup_unavailable', 'This run cannot be continued: what it was allowed to use was not recorded.');
    }
    if ((Number(run.followupDepth) || 0) + 1 > maxFollowUps()) {
        throw new HttpError(409, 'review_followup_limit', `This work has been continued ${run.followupDepth} times already. Close the review, or start the item again.`);
    }
    if (schedule.lastStatus === 'running') {
        throw new HttpError(409, 'cowork_running', 'This Cowork item is running right now. Answer when that run has finished.');
    }
    return offered.filter((n): n is string => typeof n === 'string');
}

async function followUpTrigger(
    { schedule, run, answer, followUpRunId, toolCeiling }: { schedule: Schedule; run: ReviewRun; answer: string; followUpRunId: string; toolCeiling: string[] },
    deps: Deps,
) {
    const ctx = run.runContext || {};
    const { followUpMailTrigger } = nodeRequire('../core/cowork/mailTriggerRun.mts') as {
        followUpMailTrigger: (m: MailContext, userId: string, fetch?: Deps['fetchMessage']) => Promise<Record<string, unknown>>;
    };
    const mailTrigger = ctx.mail ? await followUpMailTrigger(ctx.mail, schedule.userId, deps.fetchMessage) : null;
    const subject = run.mailSubject || null;
    return {
        runId: followUpRunId,
        toolCeiling,
        mailSubject: subject,
        prompt: buildFollowUpPrompt(String(schedule.prompt || ''), run.review, answer),
        scheduleText: 'This is a follow-up of an earlier run of this Cowork item: its owner answered the review that run asked for.',
        metadata: { ...(ctx.unattended ? { unattended: true } : {}), ...(mailTrigger ? { mailTrigger } : {}) },
        notification: ({ agentName }: { agentName: string }) => ({
            title: `${agentName} continued with your answer: ${subject ? `"${subject}"` : schedule.title}`,
            message: 'The run you answered went on. Open it in Cowork to see what it did.',
        }),
    };
}

/**
 * Handle one run that asked for review. Throws an HttpError the route passes on: 400 no answer, 404 not this item's
 * run, 409 not waiting / cannot be continued / over the follow-up limit / item running.
 */
export async function handleRunReview(
    { schedule, runId, userId, action, answer = '' }: { schedule: Schedule; runId: string; userId: string; action: ReviewAction; answer?: string },
    deps: Deps = defaultDeps(),
): Promise<{ run: Record<string, unknown> | null; followUpRunId: string | null }> {
    const run = refuseUnlessWaiting(await deps.store.getRunForReview(schedule.id, runId));
    const text = String(answer || '').trim().slice(0, MAX_ANSWER_CHARS);
    const followUp = action === 'answer';
    const toolCeiling = followUp ? assertCanContinue(schedule, run, text) : [];
    const res = await deps.store.resolveReview({ scheduleId: schedule.id, runId, userId, resolution: followUp ? 'answered' : action, followUp });
    if (!res) throw new HttpError(409, 'review_not_open', 'This run is not waiting for a review.');
    if (followUp && res.followUpRunId) {
        const trigger = await followUpTrigger({ schedule, run, answer: text, followUpRunId: res.followUpRunId, toolCeiling }, deps);
        deps.startRun({ ...schedule, conversationId: run.conversationId ?? null }, trigger);
        log.info(`[Cowork] review of run ${runId} answered; follow-up ${res.followUpRunId} started`);
    }
    return res;
}
