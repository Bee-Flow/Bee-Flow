// @typecheck strict
/**
 * App Studio — where a sequence step holds other steps. Pure: it imports only
 * the generated table of extension step kinds next to it.
 *
 * Every static walker (validators, the call-graph helpers) and the server
 * sequence walker (appStudio/sequenceWalk.mts) read the child places of a step
 * from here, so a new place (a handler, a transaction body) is added once and
 * every reader sees it.
 *
 *   condition → `.then`, `.else`
 *   loop      → `.steps`
 *   switch    → `.cases[k].steps` per case (k = the index in `cases`), then `.default`
 *   any step with an error handler → `.onError.steps` LAST (the legacy array
 *             form `onError: [...]` too); a transaction → `.steps` (not walked:
 *             a transaction is ONE server step, its children never run alone)
 *
 * `suffix` is the walker path segment the child list hangs under (the step's
 * own path + suffix + `[i]`). `walked: true` means the server walker visits the
 * list as steps; a handler is walked by the walker's failure path, not as a
 * branch, so the control-flow code picks its branches by kind, never by slot
 * position past the kind's own slots.
 *
 * ONE table says which fields of a kind hold steps (BASE_CHILD_SLOTS for the
 * base kinds, stepKinds.generated.mjs for the kinds of the step registry).
 * flattenSteps (appStudio/actionSequence.js), the browser's buildStepIndexMap
 * and the public redaction (appStudio/publicAccess.js) all read it through the
 * helpers below, so the step ordinal means the same step everywhere.
 *
 * The error-handling constants and helpers (retry plan, handler shape, the
 * `error` scope a handler reads) live here too, so the browser coordinator and
 * the server walker read one definition of them (mirrored to agent-hub).
 */

import { EXTENSION_STEP_KINDS } from './stepKinds.generated.mjs';

/** Step retry bounds: `retry: { times 0..MAX_TIMES, delayMs 0..MAX_DELAY_MS }`. */
export const STEP_RETRY = Object.freeze({ MAX_TIMES: 3, MAX_DELAY_MS: 30000, DEFAULT_DELAY_MS: 1000 });
/** Record writes one `transaction` step may hold. */
export const MAX_TRANSACTION_STEPS = 50;
/** `error.message` in a handler's scope is cut to this many characters. */
export const MAX_ERROR_MESSAGE_LEN = 500;
/** Kinds whose effect leaves Bee Flow (or waits on a person): never retried (a retry would repeat it). */
export const RETRY_UNSAFE_KINDS = Object.freeze(['send_email', 'run_automation', 'request_approval', 'ai_browse', 'copy_document']);
/** The only kinds a `transaction` holds: writes to the app's own tables. */
export const TRANSACTION_CHILD_KINDS = Object.freeze(['create_record', 'update_record', 'delete_record']);

/**
 * @typedef {{ suffix: string, steps: unknown[], walked: boolean }} StepSlot
 */

/**
 * A field of a step kind that holds child steps. `each`: the field is a list of
 * objects (switch cases) and every one holds its steps under that key.
 * `walked: false`: the children never run alone and get no ordinal.
 *
 * @typedef {{ field: string, each?: string, walked?: boolean }} ChildSlotSpec
 * @typedef {{ childSlots?: readonly ChildSlotSpec[], retrySafe?: boolean, server?: boolean }} ExtensionStepKind
 */

/** @type {Readonly<Record<string, readonly ChildSlotSpec[]>>} */
const BASE_CHILD_SLOTS = Object.freeze({
    condition: Object.freeze([Object.freeze({ field: 'then' }), Object.freeze({ field: 'else' })]),
    loop: Object.freeze([Object.freeze({ field: 'steps' })]),
    switch: Object.freeze([Object.freeze({ field: 'cases', each: 'steps' }), Object.freeze({ field: 'default' })]),
    transaction: Object.freeze([Object.freeze({ field: 'steps', walked: false })]),
});

/** @type {Readonly<Record<string, ExtensionStepKind>>} */
let extensionKinds = EXTENSION_STEP_KINDS;

/** @param {unknown} kind @returns {ExtensionStepKind | null} */
function extensionKind(kind) {
    return typeof kind === 'string' && Object.hasOwn(extensionKinds, kind) ? extensionKinds[kind] : null;
}

/**
 * The fields of `kind` that hold child steps, in pre-order. Empty for a kind
 * that holds none and for a kind nobody declared.
 *
 * @param {unknown} kind
 * @returns {readonly ChildSlotSpec[]}
 */
export function childSlotSpecs(kind) {
    if (typeof kind !== 'string') return [];
    if (Object.hasOwn(BASE_CHILD_SLOTS, kind)) return BASE_CHILD_SLOTS[kind];
    return extensionKind(kind)?.childSlots ?? [];
}

/**
 * The extension step kinds that run on the server (the registry's `side: 'server'`).
 *
 * @returns {string[]}
 */
export function extensionServerKinds() {
    return Object.keys(extensionKinds).filter((k) => extensionKinds[k].server === true);
}

/**
 * Is `kind` a step kind of the registry (the generated table)?
 *
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isExtensionStepKind(kind) {
    return extensionKind(kind) !== null;
}

/**
 * Is a failed step of this kind never tried again (its effect leaves Bee Flow, or waits on a person)?
 *
 * @param {string} kind
 * @returns {boolean}
 */
export function isRetryUnsafeKind(kind) {
    return RETRY_UNSAFE_KINDS.includes(kind) || extensionKind(kind)?.retrySafe === false;
}

/**
 * Test seam: run `fn` with `table` as the extension step kinds, then put the
 * shipped table back. Synchronous only. Product code never calls it.
 *
 * @template T
 * @param {Readonly<Record<string, ExtensionStepKind>>} table
 * @param {() => T} fn
 * @returns {T}
 */
export function withExtensionStepKinds(table, fn) {
    const shipped = extensionKinds;
    extensionKinds = table;
    try { return fn(); } finally { extensionKinds = shipped; }
}

/** @param {unknown} v @returns {unknown[]} */
const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * The places `step` holds child steps, in pre-order.
 *
 * @param {unknown} step
 * @returns {StepSlot[]}
 */
export function childStepSlots(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    const s = /** @type {Record<string, unknown>} */ (step);
    const own = ownSlots(s);
    const handler = handlerList(s.onError);
    if (handler) own.push({ suffix: '.onError.steps', steps: handler, walked: true });
    return own;
}

/** @param {unknown} h @returns {unknown[] | null} */
function handlerList(h) {
    if (Array.isArray(h)) return h;
    if (h && typeof h === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (h).steps)) {
        return /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (h).steps);
    }
    return null;
}

/**
 * The slots of the step's own kind (branches, a loop or transaction body),
 * read from the child-slot table.
 *
 * @param {Record<string, unknown>} s
 * @returns {StepSlot[]}
 */
function ownSlots(s) {
    /** @type {StepSlot[]} */
    const out = [];
    for (const spec of childSlotSpecs(s.kind)) {
        const walked = spec.walked !== false;
        const each = spec.each;
        if (each === undefined) {
            out.push({ suffix: `.${spec.field}`, steps: listOf(s[spec.field]), walked });
            continue;
        }
        listOf(s[spec.field]).forEach((c, k) => out.push({
            suffix: `.${spec.field}[${k}].${each}`,
            steps: c && typeof c === 'object' ? listOf(/** @type {Record<string, unknown>} */ (c)[each]) : [],
            walked,
        }));
    }
    return out;
}

/**
 * The child lists of the step's own kind that get step ordinals, in pre-order
 * (no error handler: handlers are numbered after the whole tree).
 *
 * @param {unknown} step
 * @returns {unknown[][]}
 */
export function numberedChildLists(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    return ownSlots(/** @type {Record<string, unknown>} */ (step)).filter((slot) => slot.walked).map((slot) => slot.steps);
}

/**
 * The steps of a step's error handler (`onError.steps`, or the legacy array
 * form), or null when it has none.
 *
 * @param {unknown} step
 * @returns {unknown[] | null}
 */
export function handlerStepsOf(step) {
    if (!step || typeof step !== 'object') return null;
    return handlerList(/** @type {Record<string, unknown>} */ (step).onError);
}

/** The fields a reader that walks child steps by name already visits. */
const NAMED_CHILD_FIELDS = Object.freeze(['steps', 'then', 'else', 'default']);

/**
 * The child places of a registry kind that a by-name reader does not visit:
 * `{ field, steps }` per plain slot outside `steps`, `then`, `else`, `default`,
 * and `{ field, index, each, steps }` per entry of a list slot other than
 * `cases[].steps`. Empty for a base kind. One more loop over this lets such a
 * reader see the containers the registry adds (a try's `catch` and `finally`),
 * and a definition without one is read exactly as before.
 *
 * @param {unknown} step
 * @returns {{ field: string, index?: number, each?: string, steps: unknown[] }[]}
 */
export function extraChildSlots(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    const s = /** @type {Record<string, unknown>} */ (step);
    const kind = extensionKind(s.kind);
    /** @type {{ field: string, index?: number, each?: string, steps: unknown[] }[]} */
    const out = [];
    for (const spec of kind?.childSlots ?? []) {
        const each = spec.each;
        if (each === undefined) {
            if (!NAMED_CHILD_FIELDS.includes(spec.field) && Array.isArray(s[spec.field])) out.push({ field: spec.field, steps: /** @type {unknown[]} */ (s[spec.field]) });
        } else if (!(spec.field === 'cases' && each === 'steps')) {
            listOf(s[spec.field]).forEach((c, index) => {
                const steps = c && typeof c === 'object' ? /** @type {Record<string, unknown>} */ (c)[each] : null;
                if (Array.isArray(steps)) out.push({ field: spec.field, index, each, steps });
            });
        }
    }
    return out;
}

/**
 * The lists of extraChildSlots, for a reader that only needs the steps.
 *
 * @param {unknown} step
 * @returns {unknown[][]}
 */
export function extraChildLists(step) {
    return extraChildSlots(step).map((slot) => slot.steps);
}

/**
 * Every child list of `step`, walked or not: what a static check reads.
 *
 * @param {unknown} step
 * @returns {unknown[][]}
 */
export function childStepLists(step) {
    return childStepSlots(step).map((s) => s.steps);
}

/**
 * The error handler of a step: `{ steps, stop }`, or null when it has none.
 * The legacy array form `onError: [...]` reads as `{ steps, stop: true }` (it
 * always ended the run quietly; an empty one handled nothing and is null); an
 * object without `steps` (an action-level
 * effects object such as `{ toast }`) is not a step handler.
 *
 * @param {unknown} step
 * @returns {{ steps: unknown[], stop: boolean } | null}
 */
export function errorHandlerOf(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
    const h = /** @type {Record<string, unknown>} */ (step).onError;
    // An EMPTY legacy array never handled anything (the runner checked its length).
    if (Array.isArray(h)) return h.length ? { steps: h, stop: true } : null;
    if (h && typeof h === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (h).steps)) {
        const o = /** @type {Record<string, unknown>} */ (h);
        return { steps: /** @type {unknown[]} */ (o.steps), stop: o.stop === true };
    }
    return null;
}

/** @param {unknown} v @param {number} max @param {number} dflt @returns {number} */
function clampInt(v, max, dflt) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(0, Math.floor(n)));
}

/**
 * How often a failed step is tried again and how long to wait in between,
 * clamped to STEP_RETRY. `{ times: 0, delayMs: 0 }` when the step has no retry
 * or its kind is never retried.
 *
 * @param {unknown} step
 * @returns {{ times: number, delayMs: number }}
 */
export function retryPlanOf(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return { times: 0, delayMs: 0 };
    const s = /** @type {Record<string, unknown>} */ (step);
    if (typeof s.kind === 'string' && isRetryUnsafeKind(s.kind)) return { times: 0, delayMs: 0 };
    const r = s.retry;
    const raw = typeof r === 'number' ? { times: r } : r && typeof r === 'object' && !Array.isArray(r) ? /** @type {Record<string, unknown>} */ (r) : null;
    if (!raw) return { times: 0, delayMs: 0 };
    const times = clampInt(raw.times, STEP_RETRY.MAX_TIMES, 0);
    if (!times) return { times: 0, delayMs: 0 };
    return { times, delayMs: clampInt(raw.delayMs, STEP_RETRY.MAX_DELAY_MS, STEP_RETRY.DEFAULT_DELAY_MS) };
}

/**
 * The `error` scope a handler reads, from an untrusted bag (a /step body, a
 * walker failure): `{ message, step, code, attempts, stepIndex? }`, bounded.
 * Null when `raw` is not an object.
 *
 * @param {unknown} raw
 * @returns {{ message: string, step: string, code: string | null, attempts: number, stepIndex?: number } | null}
 */
export function clampErrorScope(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = /** @type {Record<string, unknown>} */ (raw);
    const text = (/** @type {unknown} */ v, /** @type {number} */ max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const attempts = clampInt(r.attempts, STEP_RETRY.MAX_TIMES + 1, 1);
    /** @type {{ message: string, step: string, code: string | null, attempts: number, stepIndex?: number }} */
    const out = {
        message: text(r.message, MAX_ERROR_MESSAGE_LEN),
        step: text(r.step, 60),
        code: typeof r.code === 'string' && r.code ? r.code.slice(0, 60) : null,
        attempts: Math.max(1, attempts),
    };
    if (Number.isInteger(r.stepIndex) && /** @type {number} */ (r.stepIndex) >= 0) out.stepIndex = /** @type {number} */ (r.stepIndex);
    return out;
}
