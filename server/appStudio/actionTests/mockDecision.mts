/**
 * The mocked decision of an `await_approval` step in a test run (app_run_action, app_run_tests).
 *
 * A test run never asks anybody and never waits: the step ends at once with a decision. Without a
 * mock that is "approved"; a mock names another one, as a word or as the decision object the
 * step's resultVar gets in a real run:
 *
 *   "rejected"
 *   { "decision": "rejected", "reason": "Too expensive" }
 *   { "decision": "approved", "answers": { "costCenter": "4100" }, "decidedByName": "Finance" }
 *
 * The result has the shape a real decision has (approvalWaits.decisionOf), with approvalId
 * "mock", so a condition on vars.<resultVar>.decision behaves as it will for real.
 */

import type { StepResult } from '../sequenceWalkTypes.mts';

type Obj = Record<string, unknown>;

export const MOCK_DECISIONS: readonly string[] = Object.freeze(['approved', 'rejected', 'expired', 'cancelled']);
const DEFAULT_NOTE = 'mocked: nobody was asked; the step went on as approved (mock it to test another decision)';

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

/** Marks the answer a test run made up itself (no mock given): its result carries a note that says so. */
const UNMOCKED: unique symbol = Symbol('unmocked');

/** The mock a test run uses for a step nobody mocked: an approval is approved. Null for every other kind. */
export function defaultMockOf(step: unknown): { value: unknown } | null {
    return isObject(step) && step.kind === 'await_approval' ? { value: { decision: 'approved', [UNMOCKED]: true } } : null;
}

/** The step result of a mocked decision. */
export function mockDecision(answer: unknown): StepResult {
    const given = isObject(answer) ? answer : { decision: answer };
    const decision = typeof given.decision === 'string' ? given.decision : '';
    if (!MOCK_DECISIONS.includes(decision)) {
        return { ok: false, error: `The mock of an await_approval must be one of ${MOCK_DECISIONS.join(', ')}, or { decision, reason?, answers? }`, retryable: false };
    }
    return {
        ok: true,
        result: {
            decision, reason: text(given.reason, 2000), answers: isObject(given.answers) ? given.answers : null,
            decidedBy: text(given.decidedBy, 80), decidedByName: text(given.decidedByName, 120), decidedAt: null, approvalId: 'mock',
        },
        ...(isObject(answer) && (answer as { [UNMOCKED]?: boolean })[UNMOCKED] === true ? { notes: [DEFAULT_NOTE] } : {}),
    };
}
