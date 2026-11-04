// @typecheck strict
/**
 * App Studio — where a sequence step holds other steps. Pure, imports nothing.
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
 * flattenSteps (appStudio/actionSequence.js) deliberately does NOT use this: the
 * mobile lockstep test lifts that function by its own source text, so it stays
 * self-contained. Its order (then, else / steps / cases, default) is the order
 * of the slots below.
 *
 * The error-handling constants and helpers (retry plan, handler shape, the
 * `error` scope a handler reads) live here too, so the browser coordinator and
 * the server walker read one definition of them (mirrored to agent-hub).
 */

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
 * The slots of the step's own kind (branches, a loop or transaction body).
 *
 * @param {Record<string, unknown>} s
 * @returns {StepSlot[]}
 */
function ownSlots(s) {
    if (s.kind === 'condition') {
        return [
            { suffix: '.then', steps: listOf(s.then), walked: true },
            { suffix: '.else', steps: listOf(s.else), walked: true },
        ];
    }
    if (s.kind === 'loop') return [{ suffix: '.steps', steps: listOf(s.steps), walked: true }];
    if (s.kind === 'transaction') return [{ suffix: '.steps', steps: listOf(s.steps), walked: false }];
    if (s.kind === 'switch') {
        /** @type {StepSlot[]} */
        const out = listOf(s.cases).map((c, k) => ({
            suffix: `.cases[${k}].steps`,
            steps: c && typeof c === 'object' ? listOf(/** @type {Record<string, unknown>} */ (c).steps) : [],
            walked: true,
        }));
        out.push({ suffix: '.default', steps: listOf(s.default), walked: true });
        return out;
    }
    return [];
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
    if (typeof s.kind === 'string' && RETRY_UNSAFE_KINDS.includes(s.kind)) return { times: 0, delayMs: 0 };
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
