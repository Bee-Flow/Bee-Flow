/**
 * The catalog text of step error handling: the onError / retry envelope every
 * server step carries, taught ONCE in the steps lead instead of per kind, and
 * the transaction line. catalogRender.js renders it into the full catalog only
 * (the compact catalog names the kind; section 4 of the round's prompt budget).
 */

import { createRequire } from 'node:module';
import { RETRY_UNSAFE_KINDS } from '../../shared/appDefinition/stepFlow.mjs';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('../componentSpecs/limits.js') as {
    LIMITS: { MAX_STEP_RETRY_TIMES: number; MAX_STEP_RETRY_DELAY_MS: number; DEFAULT_STEP_RETRY_DELAY_MS: number; MAX_TRANSACTION_STEPS: number };
};

type FieldSpec = { envelope?: boolean; since?: unknown } & Record<string, unknown>;

/**
 * A kind's own fields: the envelope (retry / onError) is left out, the lead below explains it.
 * Fields marked `since: 3` (or later) are left out too: they are not part of the pinned base
 * catalogue text (DESIGN-foundation 2.1).
 */
export function ownFields<T extends FieldSpec>(fields: Record<string, T>): Record<string, T> {
    return Object.fromEntries(Object.entries(fields).filter(([, fs]) => !fs.envelope && !(typeof fs.since === 'number' && fs.since >= 3)));
}

/** The two lines of the steps lead: the envelope, and the transaction step. */
export function errorHandlingLines(): string[] {
    return [
        `[SERVER] steps and call_action may carry onError: { steps, stop?: true }: on failure those steps run with error.message/step/code/attempts in scope, then the sequence CONTINUES (stop: true ends it quietly; without onError the failure stops it). [SERVER] steps except ${RETRY_UNSAFE_KINDS.join('/')} may carry retry: { times ≤${LIMITS.MAX_STEP_RETRY_TIMES}, delayMs ≤${LIMITS.MAX_STEP_RETRY_DELAY_MS} (${LIMITS.DEFAULT_STEP_RETRY_DELAY_MS}) }, used only when retrying can help.`,
        `transaction: ≤${LIMITS.MAX_TRANSACTION_STEPS} create/update/delete_record on the app's own (not linked) tables, saved all or none (an update/delete that finds no record rolls back the rest); child resultVars are readable by later children and after it; children carry no onError/retry.`,
    ];
}
