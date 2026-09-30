/**
 * The step walk the action runner and the server must agree on, and the small
 * pure helpers of the web's action runner (agent-hub AppStudio/runtime/
 * useActionRunner.js).
 *
 * `stepIndex` is never stored. The phone, the browser and the server each
 * derive it by walking the saved step tree in the same PRE-ORDER (a step, then
 * its branches: condition then/else, loop body, switch cases then default),
 * and a server step is dispatched as { stepIndex } alone: the server resolves
 * the step from its own copy of the definition. So buildStepIndexMap must be
 * byte-for-byte the server's flattenSteps (server/appStudio/actionSequence.js);
 * stepIndex.lockstep.test.ts runs both on the same trees.
 */

import { tryEvaluate } from '@/shared/expr';

import type { ActionStep, AppAction } from '../types';

/** Every step kind (server STEP_KINDS, componentSpecs/actionSpecs.js), in its order. */
export const STEP_KINDS = [
    'navigate', 'toast', 'open_url', 'open_modal', 'close_modal', 'reset_form', 'download_file', 'confirm', 'set_variable', 'refresh',
    'run_automation', 'create_record', 'update_record', 'delete_record', 'request_approval',
    'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query', 'ai_browse',
    'condition', 'loop', 'switch',
] as const;

/**
 * Server-executed kinds: POSTed to /actions/:id/step. Equal to the server's
 * DATA_MUTATING_STEP_KINDS and the web runner's SERVER_STEP_KINDS; a kind
 * missing here would silently become a client no-op.
 */
export const SERVER_STEP_KINDS: ReadonlySet<string> = new Set([
    'run_automation', 'create_record', 'update_record', 'delete_record', 'request_approval',
    'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document',
    'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query', 'ai_browse',
]);

/** Client-executed kinds (the server's CLIENT_STEP_KINDS): chrome, navigation, flow control. */
export const CLIENT_STEP_KINDS: readonly string[] = STEP_KINDS.filter((k) => !SERVER_STEP_KINDS.has(k));

/** Kinds that hold other steps. */
export const FLOW_STEP_KINDS: ReadonlySet<string> = new Set(['condition', 'loop', 'switch']);

/** Client-side ceiling on loop iterations (LIMITS.MAX_ACTION_LOOP_ITERATIONS). */
export const MAX_LOOP_ITERATIONS = 200;

export const isServerStep = (step: unknown): boolean =>
    !!step && typeof step === 'object' && SERVER_STEP_KINDS.has((step as ActionStep).kind);

/** A bare v1 action is an implicit 1-step sequence; a v2 action carries its steps. */
export function normalizeSequence(action: AppAction | ActionStep | null | undefined): ActionStep[] {
    if (!action || typeof action !== 'object') return [];
    if (action.kind === 'sequence') return Array.isArray(action.steps) ? (action.steps as ActionStep[]) : [];
    return [action as ActionStep];
}

/** Pre-order walk, the server's flattenSteps: every step object, in index order. */
export function flattenSteps(steps: unknown, out: ActionStep[] = []): ActionStep[] {
    for (const step of Array.isArray(steps) ? steps : []) {
        if (!step || typeof step !== 'object') continue;
        const s = step as ActionStep;
        out.push(s);
        if (s.kind === 'condition') {
            flattenSteps(s.then, out);
            flattenSteps(s.else, out);
        } else if (s.kind === 'loop') {
            flattenSteps(s.steps, out);
        } else if (s.kind === 'switch') {
            for (const c of Array.isArray(s.cases) ? s.cases : []) {
                if (c && typeof c === 'object') flattenSteps((c as { steps?: unknown }).steps, out);
            }
            flattenSteps(s.default, out);
        }
    }
    return out;
}

/** Map(step object -> stepIndex), the ordinal the server resolves. */
export function buildStepIndexMap(steps: unknown): Map<ActionStep, number> {
    const map = new Map<ActionStep, number>();
    // A step object reachable twice keeps its LAST ordinal, as the web's map
    // does; both ordinals name the same object on the server.
    flattenSteps(steps).forEach((step, i) => map.set(step, i));
    return map;
}

/** Does any step in the tree run on the server? Only then does the trigger show a spinner. */
export function sequenceHasServerStep(steps: unknown): boolean {
    return flattenSteps(steps).some(isServerStep);
}

/** Loose switch-case match: tolerates a number-vs-string authoring mismatch. */
export function caseMatches(caseValue: unknown, exprValue: unknown): boolean {
    if (caseValue === exprValue) return true;
    if (caseValue == null || exprValue == null) return false;
    return String(caseValue) === String(exprValue);
}

/**
 * A navigate action/step's optional params map, resolved against the live
 * scope: { key: {kind:'static',value} | {kind:'formula',expr} } -> { key: value }.
 */
export function resolveNavParams(params: unknown, scope: Record<string, unknown>): Record<string, unknown> {
    if (!params || typeof params !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(params)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as { kind?: unknown; value?: unknown; expr?: unknown };
        if (e.kind === 'static') out[key] = e.value;
        else if (e.kind === 'formula') out[key] = tryEvaluate(e.expr as string, scope).value;
    }
    return out;
}
