/**
 * The pure step walk of a sequence: which kinds go to the server, the
 * pre-order step ordinals the server resolves too, switch-case matching and
 * navigate params. No React, no network — the mobile port's lockstep test
 * (mobile …/runtime/stepIndex.lockstep.test.ts) loads this module as is.
 */
import { tryEvaluate } from '@shared/expr/engine.mjs';
import type { BindingInput } from '../resolveBinding.types';

/**
 * One step of a sequence, as it arrives from the definition. Every member is
 * optional and loosely typed on purpose: the definition is authored data, and
 * each step kind reads its own fields defensively.
 */
export interface RunStep {
    kind?: unknown;
    resultVar?: unknown;
    onError?: unknown;
    screenId?: string;
    params?: unknown;
    tone?: string;
    message?: string;
    url?: unknown;
    newTab?: boolean;
    modalId?: string;
    form?: unknown;
    file?: BindingInput;
    fileName?: BindingInput;
    name?: unknown;
    value?: BindingInput;
    tableId?: string | null;
    datasetId?: string | null;
    expr?: string;
    then?: unknown;
    else?: unknown;
    cases?: unknown;
    default?: unknown;
    source?: BindingInput;
    maxIterations?: unknown;
    itemVar?: unknown;
    indexVar?: unknown;
    steps?: unknown;
    [key: string]: unknown;
}

// Ceiling on loop iterations client-side (matches LIMITS.MAX_ACTION_LOOP_ITERATIONS).
export const MAX_LOOP_ITERATIONS = 200;

// Server-authoritative step kinds — dispatched to the /step endpoint. This MUST
// equal DATA_MUTATING_STEP_KINDS (componentSpecs.js); a kind the server knows
// but this set omits falls through execStep's `default: return` and becomes a
// SILENT no-op — the surrounding sequence keeps running and still reports
// success. `send_email` was missing here and did exactly that: the support desk
// toasted "Reply sent" while nothing was ever sent. useActionRunner.stepKinds
// .test.js now pins the two lists together.
// MUST equal DATA_MUTATING_STEP_KINDS (componentSpecs.js). ai_browse is in the
// set for that invariant, but execStep intercepts it FIRST (it streams over a
// dedicated SSE endpoint, not the plain JSON /step dispatch) — the generic
// branch below never sees it.
export const SERVER_STEP_KINDS: ReadonlySet<unknown> = new Set(['run_automation', 'create_record', 'update_record', 'delete_record', 'request_approval', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query', 'ai_browse', 'copy_document']);

// A bare v1 action is an implicit 1-step sequence; a v2 action carries its steps.
export function normalizeSequence(action: RunStep | null | undefined): unknown[] {
    if (!action || typeof action !== 'object') return [];
    if (action.kind === 'sequence') return Array.isArray(action.steps) ? action.steps : [];
    return [action];
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// Pre-order flatten — BYTE-IDENTICAL to the server's flattenSteps
// (routes/studioAppsRun.js) so a step's ordinal here is the same one the server
// resolves from the definition. Returns a Map(step → index).
export function buildStepIndexMap(steps: unknown): Map<RunStep, number> {
    const map = new Map<RunStep, number>();
    let i = 0;
    const walk = (list: unknown) => {
        for (const raw of listOf(list)) {
            if (!raw || typeof raw !== 'object') continue;
            const step = raw as RunStep;
            map.set(step, i++);
            if (step.kind === 'condition') { walk(step.then); walk(step.else); }
            else if (step.kind === 'loop') { walk(step.steps); }
            else if (step.kind === 'switch') {
                for (const c of listOf(step.cases)) {
                    if (c && typeof c === 'object') walk((c as { steps?: unknown }).steps);
                }
                walk(step.default);
            }
        }
    };
    walk(steps);
    return map;
}

export function sequenceHasServerStep(steps: unknown): boolean {
    for (const [step] of buildStepIndexMap(steps)) {
        if (step && SERVER_STEP_KINDS.has(step.kind)) return true;
    }
    return false;
}

// Loose switch-case match: tolerate a number-vs-string authoring mismatch.
export function caseMatches(caseValue: unknown, exprValue: unknown): boolean {
    if (caseValue === exprValue) return true;
    if (caseValue == null || exprValue == null) return false;
    return String(caseValue) === String(exprValue);
}

// Resolve a navigate action/step's optional params map against the live scope:
// { key: {kind:'static',value} | {kind:'formula',expr} } → { key: value }.
export function resolveNavParams(params: unknown, scope: unknown): Record<string, unknown> {
    if (!params || typeof params !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(params)) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as { kind?: unknown; value?: unknown; expr?: unknown };
        if (entry.kind === 'static') out[key] = entry.value;
        else if (entry.kind === 'formula') out[key] = tryEvaluate(entry.expr, scope).value;
    }
    return out;
}
