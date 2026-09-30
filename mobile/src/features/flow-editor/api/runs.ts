/**
 * Test runs from the editor (routes/automation/runs.js): one step, the flow up
 * to a step, a step and everything after it, or a dry run of the whole flow.
 *
 * They run the STORED definition, not the one on screen — the editor flushes
 * its autosave first. A step run replays upstream output from the latest run
 * and any pinned outputs; `upTo` really executes the steps before it unless
 * they are pinned. Both are rate-limited with the other run triggers
 * (AUTOMATION_RUN_TRIGGER_RPM), and neither is retried: a run that timed out
 * on the phone may still be running on the server.
 */

import { api } from '@/core/api/client';

import { flowPath } from './definition';
import { readStepRun, readTestRun } from './readers';
import type { StepRunMode, StepRunResult, TestRunResult } from './types';

/** The server waits for the whole run; a dry run of a long flow takes a while. */
const TEST_RUN_TIMEOUT_MS = 3 * 60_000;

export interface TestRunInput {
    /** What the run enters with — a sample form submission, a message. */
    triggerPayload?: unknown;
    /** Which trigger to enter through (a secondary one); the primary when omitted. */
    triggerStepId?: string | null;
}

/**
 * The body: `triggerPayload` only when there is one — an explicit null reads
 * as "deliberately empty" to the next person — and the same for the trigger.
 */
function runBody(input: TestRunInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ...extra,
        ...(input.triggerPayload == null ? {} : { triggerPayload: input.triggerPayload }),
        ...(input.triggerStepId ? { triggerStepId: input.triggerStepId } : {}),
    };
}

export async function runStep(id: string, stepId: string, mode: StepRunMode = 'only', input: TestRunInput = {}): Promise<StepRunResult> {
    const res = await api.post<unknown>(`${flowPath(id)}/steps/${encodeURIComponent(stepId)}/run`, runBody(input, { mode }), {
        timeoutMs: TEST_RUN_TIMEOUT_MS,
        retry: false,
    });
    return readStepRun(res);
}

export async function dryRun(id: string, input: TestRunInput = {}): Promise<TestRunResult> {
    const res = await api.post<unknown>(`${flowPath(id)}/dry-run`, runBody(input), {
        timeoutMs: TEST_RUN_TIMEOUT_MS,
        retry: false,
    });
    return readTestRun(res);
}
