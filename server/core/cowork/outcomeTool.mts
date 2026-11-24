/**
 * `cowork_report_outcome`: the tool the AI of a Cowork run WITHOUT a plan (a prompt run, core/aiTaskRunner.js, or a
 * run as an agent, ./agentScheduleRun.js) calls last, with its own verdict on the run: done, nothing to do, or failed,
 * and at most one short sentence why. A plan's AI steps give the same verdict in their structured output
 * (core/automationRunner/aiStepVerdict.mts).
 *
 * The AI can only make a run worse, never better (decision 0050): `failed` turns a would-be success into a failed run
 * with the AI's reason; `done` and `nothing_to_do` change nothing. Text from outside (a mail, a tool result) could push
 * the AI to say `failed`: that costs the owner a notification, never a send.
 *
 * Offered only in a Cowork run (an agent run: core/agentRuntime/toolStackAssembly.js, next to the review tool; a prompt
 * run: core/aiTaskRunner.js prepareTaskRun) and allowed in a run started by an e-mail
 * (core/agentRuntime/toolPolicy/mailRun.mts): it reaches nothing outside Bee Flow, it only writes the verdict onto the
 * run's own context.
 */

import { verdictOf, type Verdict } from '../automationRunner/aiStepVerdict.mts';
import { OUTCOME_TOOL_NAME } from './runActivity.mts';

export { OUTCOME_TOOL_NAME };

export function outcomeToolDef() {
    return {
        type: 'function',
        function: {
            name: OUTCOME_TOOL_NAME,
            description: [
                'Report how this Cowork run went, as your last tool call before your final answer.',
                'outcome "done": you did what the task asks.',
                'outcome "nothing_to_do": you checked and there was genuinely nothing this time (for example no meetings in the period, no new mail).',
                'outcome "failed": you could not do what the task asks: the data you needed was missing or empty where it should not be, the input made no sense, or a tool you needed errored.',
                'Give the reason in at most one short sentence. Call it once.',
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    outcome: { type: 'string', enum: ['done', 'nothing_to_do', 'failed'] },
                    reason: { type: 'string', description: 'Why, in at most one short sentence.' },
                },
                required: ['outcome'],
            },
        },
    };
}

/** A run context the verdict can be written on: a Cowork run's activity, or a prompt run's own state. */
interface Holder { outcome?: Verdict | null }

/** Offer the tool once, to a run that has a place to keep the verdict. */
export function addOutcomeTool(tools: Array<{ function?: { name?: unknown } }>, holder: unknown): void {
    if (!holder || typeof holder !== 'object') return;
    if (tools.some((t) => t.function?.name === OUTCOME_TOOL_NAME)) return;
    tools.push(outcomeToolDef());
}

/** Write the verdict on the run's context. Never throws; a second call keeps the worse verdict of the two. */
export function executeOutcomeTool(args: unknown, holder: Holder | null | undefined) {
    if (!holder || typeof holder !== 'object') return { error: `${OUTCOME_TOOL_NAME} is only available in a Cowork run.` };
    const verdict = verdictOf(args);
    if (!verdict) return { error: 'Give the outcome: "done", "nothing_to_do" or "failed".' };
    if (holder.outcome?.outcome !== 'failed') holder.outcome = verdict;
    return { ok: true, message: 'The outcome is recorded. Now give your final answer.' };
}

/** The name of the error a run fails with because its AI said so. */
export const AI_VERDICT_ERROR = 'AiVerdictError';

/** What a run's row keeps of the verdict (cowork_runs.outcome_json): the code alone, never the reason. */
export function outcomeClose(holder: Holder | null | undefined, err: Error | null = null): { outcome?: { kind: string } } {
    if (err) return err.name === AI_VERDICT_ERROR ? { outcome: { kind: 'ai_failed' } } : {};
    const kind = holder?.outcome?.outcome;
    return kind === 'done' || kind === 'nothing_to_do' ? { outcome: { kind } } : {};
}

/** Throw the error a run fails with when its AI said it failed; nothing when it did not. */
export function throwIfFailed(holder: Holder | null | undefined): void {
    const err = failureOf(holder);
    if (err) throw err;
}

/** A prompt run's tool dispatcher with the outcome tool answered on the run itself. */
export function withOutcomeTool<T>(holder: Holder, dispatch: (name: string, args: unknown) => Promise<T>) {
    return (name: string, args: unknown): Promise<T | ReturnType<typeof executeOutcomeTool>> => (name === OUTCOME_TOOL_NAME ? Promise.resolve(executeOutcomeTool(args, holder)) : dispatch(name, args));
}

/** The error a run fails with when its AI said it failed; null when it did not. */
export function failureOf(holder: Holder | null | undefined): Error | null {
    const v = holder?.outcome;
    if (v?.outcome !== 'failed') return null;
    const err = new Error(`The AI says: ${v.reason ?? 'it could not do what the task asks.'}`);
    err.name = AI_VERDICT_ERROR;
    return err;
}
