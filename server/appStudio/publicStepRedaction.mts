/**
 * What an anonymous visitor's browser gets of one action step (publicAccess.js builds the
 * public definition from it).
 *
 * A server step is reduced to what the browser coordinator reads: its kind, `resultVar`, its
 * retry plan and its error handler. A client step runs in the browser, so its own fields travel,
 * but the steps it holds are redacted one by one. WHERE a kind holds steps comes from the one
 * child-slot table (shared/appDefinition/stepFlow.mjs), the table that numbers the steps: every
 * step that has an ordinal is still there, in the same place, so the index a visitor posts
 * names the same step on the server.
 *
 * A step whose kind this install's catalogue does not know is reduced like a server step.
 * A field that carries steps without being a slot of the step's kind does not travel at all.
 * Nothing numbers those steps and the browser never walks them, so leaving the field out changes
 * no ordinal; passing it through would hand a visitor the configuration of server steps.
 */

import { createRequire } from 'node:module';
import { childSlotSpecs, extensionServerKinds, isExtensionStepKind } from '../shared/appDefinition/stepFlow.mjs';

const nodeRequire = createRequire(import.meta.url);
const { STEP_KINDS, DATA_MUTATING_STEP_KINDS } = nodeRequire('./componentSpecs/actionSpecsActionKinds.js') as { STEP_KINDS: string[]; DATA_MUTATING_STEP_KINDS: string[] };
const { BINDING_KINDS, INPUT_MAPPING_KINDS } = nodeRequire('./componentSpecs/bindings.js') as { BINDING_KINDS: string[]; INPUT_MAPPING_KINDS: string[] };

/** The `kind`s of a value (a binding, an input mapping): data a step reads, never a step. */
const VALUE_KINDS = new Set([...BINDING_KINDS, ...INPUT_MAPPING_KINDS]);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deeper than any definition the validator accepts; past it a value counts as holding steps. */
const MAX_SCAN_DEPTH = 16;

/**
 * Is there a step anywhere inside `value` (a step list, cases with steps, a handler)? An object
 * with a `kind` is a value when its kind is a binding's (what is inside a binding is data, so the
 * scan stops there) and a step otherwise, whether this install knows that step kind or not.
 */
export function holdsSteps(value: unknown, depth = 0): boolean {
    if (value === null || typeof value !== 'object') return false;
    if (depth > MAX_SCAN_DEPTH) return true;
    if (isObject(value) && typeof value.kind === 'string') return !VALUE_KINDS.has(value.kind);
    return Object.values(value).some((v) => holdsSteps(v, depth + 1));
}

const isServerKind = (kind: unknown): boolean => typeof kind === 'string' && (DATA_MUTATING_STEP_KINDS.includes(kind) || extensionServerKinds().includes(kind));
/** A kind this install's catalogue names. A step of any other kind is reduced like a server step: nobody said its fields may travel. */
const isKnownKind = (kind: unknown): boolean => typeof kind === 'string' && (STEP_KINDS.includes(kind) || isExtensionStepKind(kind));

/** A step's onError handler with its steps redacted, or null when it has none. */
function redactedHandler(step: Obj): unknown[] | Obj | null {
    const h = step.onError;
    if (Array.isArray(h)) return h.map(redactStep);
    if (isObject(h) && Array.isArray(h.steps)) return { steps: h.steps.map(redactStep), ...(h.stop === true ? { stop: true } : {}) };
    return null;
}

/** One entry of an `each` slot (a switch case): its own keys, its steps redacted. */
function redactEntry(entry: unknown, each: string): unknown {
    if (!isObject(entry)) return holdsSteps(entry) ? null : entry;
    const out: Obj = {};
    for (const [key, value] of Object.entries(entry)) {
        if (key === each && Array.isArray(value)) out[key] = value.map(redactStep);
        else if (!holdsSteps(value)) out[key] = value;
    }
    return out;
}

/** One step, as an anonymous visitor's browser gets it. */
export function redactStep(step: unknown): unknown {
    if (!isObject(step)) return step;
    const handler = redactedHandler(step);
    if (isServerKind(step.kind) || !isKnownKind(step.kind)) {
        // The browser retries and handles a failure itself, so `retry` and the handler travel
        // (the handler's steps redacted, so their ordinals stay). The children of a server step
        // (a transaction's writes) have no ordinal and stay on the server. A kind the catalogue
        // does not know gets the same reduction: the browser cannot run it and nothing numbers
        // what it holds.
        return {
            kind: step.kind,
            ...(step.resultVar ? { resultVar: step.resultVar } : {}),
            ...(isObject(step.retry) ? { retry: { ...step.retry } } : {}),
            ...(handler ? { onError: handler } : {}),
        };
    }
    const slots = new Map(childSlotSpecs(step.kind).map((slot) => [slot.field, slot]));
    const out: Obj = {};
    for (const [key, value] of Object.entries(step)) {
        const slot = slots.get(key);
        if (key === 'onError' && handler) out[key] = handler;
        else if (slot && Array.isArray(value)) out[key] = slot.each === undefined ? value.map(redactStep) : value.map((entry) => redactEntry(entry, slot.each as string));
        else if (!holdsSteps(value)) out[key] = value;
    }
    return out;
}
