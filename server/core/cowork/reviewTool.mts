/**
 * `cowork_request_review`: the tool an agent in a Cowork run calls when a person has to decide before the work can be
 * finished. A structured signal instead of a sentence in the final answer ("Status: human review required") that the
 * product would have to guess from.
 *
 * Offered only in a Cowork run (core/agentRuntime/toolStackAssembly.js adds it when `messageMetadata.coworkRun` is
 * set), and allowed in a run started by an e-mail (core/agentRuntime/toolPolicy/mailRun.mts): it reaches nothing
 * outside Bee Flow. It writes the request onto the run context; core/cowork/agentScheduleRun.js closes the run as
 * `needs_review` with it, and Cowork shows it under "To review", where the item's owner answers it (a follow-up run in
 * the same context) or closes it.
 */

import { isRunActivity, REVIEW_TOOL_NAME } from './runActivity.mts';

export { REVIEW_TOOL_NAME };

export const REVIEW_LIMITS = Object.freeze({ reason: 500, question: 1000, summary: 2000 });

export function reviewToolDef() {
    return {
        type: 'function',
        function: {
            name: REVIEW_TOOL_NAME,
            description: [
                'Ask the person who owns this Cowork item to review the work before it is finished.',
                'Use it instead of writing "human review required" (or similar) in your answer, whenever:',
                'you cannot finish the task without a decision, a fact or an approval only that person can give;',
                'what the task asks would go against an instruction, an agreement or a policy you were given;',
                'a tool you need was refused or is not available to you, and the task cannot be done without it;',
                'or the input is ambiguous enough that acting on a guess could do harm (a wrong price, a wrong recipient).',
                'Do not use it for things you can find out yourself with your tools, and do not ask the same thing twice.',
                'Give the reason in one or two sentences, the concrete question you need answered, and a short summary of',
                'what you already did. Calling it is not your final answer: after it, end the run with a short note of what',
                'you did and what is waiting. The person answers in Cowork, and the run then continues with that answer.',
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Why a person has to look at this, in one or two plain sentences.' },
                    question: { type: 'string', description: 'The concrete question or decision you need from the person.' },
                    summary: { type: 'string', description: 'What you already did in this run, in a few sentences.' },
                },
                required: ['reason'],
            },
        },
    };
}

/** Offer the review tool in a Cowork run, once (core/agentRuntime/toolStackAssembly.js). */
export function addReviewTool(tools: Array<{ function?: { name?: unknown } }>, coworkRun: unknown): void {
    if (!isRunActivity(coworkRun)) return;
    if (tools.some((t) => t.function?.name === REVIEW_TOOL_NAME)) return;
    tools.push(reviewToolDef());
}

function text(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const t = value.trim();
    return t ? t.slice(0, max) : null;
}

/** The executor the tool dispatcher runs (core/tools/builtinToolFamilies.js). Never throws. */
export async function executeReviewTool(_toolName: string, args: unknown, context: { coworkRun?: unknown } | null | undefined) {
    const coworkRun = context?.coworkRun;
    if (!isRunActivity(coworkRun)) {
        return { error: `${REVIEW_TOOL_NAME} is only available in a Cowork run.` };
    }
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const reason = text(a.reason, REVIEW_LIMITS.reason);
    if (!reason) return { error: 'Give the reason the person has to review this.' };
    coworkRun.review = {
        reason,
        question: text(a.question, REVIEW_LIMITS.question),
        summary: text(a.summary, REVIEW_LIMITS.summary),
    };
    return {
        ok: true,
        message: 'The review request is recorded. The owner of this Cowork item will see it under "To review". Finish the run with a short note of what you did and what is waiting; do not repeat the request.',
    };
}
