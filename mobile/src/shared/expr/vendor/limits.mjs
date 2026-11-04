// @typecheck strict
/**
 * Size limits of the expression engine, and the error every limit throws.
 *
 * An expression runs inside the server (automations, pages), the browser and
 * the phone, always on the thread that serves everyone else, so no single
 * expression may build a value whose size the author chooses freely: a pad
 * width, a replacement that multiplies its input, a concatenation chain. The
 * engine checks every text a function or operator produces against
 * MAX_TEXT_CHARS, and the functions that can grow a text by more than their
 * inputs (replace, concat, join) check BEFORE they build it.
 *
 * The cap is read once from EXPR_MAX_TEXT_CHARS when there is an environment
 * (the server); 0 means unlimited. The browser and the phone keep the default.
 */

/** padStart() never pads beyond this many code points. */
export const MAX_PAD_WIDTH = 65_536;

/** The longest text one function call or `+` may produce (UTF-16 code units). */
export const DEFAULT_MAX_TEXT_CHARS = 1_000_000;

export class ExprError extends Error {
    /** @param {string} message @param {number} [index] */
    constructor(message, index) { super(message); this.name = 'ExprError'; this.index = index; }
}

/** The text a limit refused; `code` lets a host tell it from a grammar error. */
export class ExprLimitError extends ExprError {
    /** @param {string} message */
    constructor(message) { super(message); this.code = 'expr_limit'; }
}

/**
 * A cap from the environment: unset or unreadable gives the default, 0 unlimited.
 * @param {string} name @param {number} fallback
 */
function readEnvCap(name, fallback) {
    const raw = globalThis.process?.env?.[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n === 0 ? Infinity : Math.trunc(n);
}

let maxTextChars = readEnvCap('EXPR_MAX_TEXT_CHARS', DEFAULT_MAX_TEXT_CHARS);

/** The current cap; Infinity when unlimited. */
export function getMaxTextChars() { return maxTextChars; }

/**
 * Set the cap for this process (tests, a host with its own setting); 0 or Infinity = unlimited.
 * @param {number} n
 */
export function setMaxTextChars(n) {
    maxTextChars = (n === 0 || n === Infinity) ? Infinity : Math.max(1, Math.trunc(Number(n) || DEFAULT_MAX_TEXT_CHARS));
}

/**
 * Throw when a text of `length` code units would pass the cap.
 * @param {number} length
 */
export function assertTextSize(length) {
    if (length > maxTextChars) {
        throw new ExprLimitError(`Text longer than ${maxTextChars} characters`);
    }
}

/**
 * The value a function or operator produced: a text past the cap is refused, anything else passes.
 * @template T
 * @param {T} v
 */
export function guardValue(v) {
    if (typeof v === 'string') assertTextSize(v.length);
    return v;
}

/**
 * How many items map/filter/some/every may visit in ONE evaluation, counted
 * over every list function in it (nested ones multiply). Read once from
 * EXPR_MAX_EACH_STEPS when there is an environment; 0 means unlimited.
 */
export const DEFAULT_MAX_EACH_STEPS = 200_000;

let maxEachSteps = readEnvCap('EXPR_MAX_EACH_STEPS', DEFAULT_MAX_EACH_STEPS);

/** The current item budget per evaluation; Infinity when unlimited. */
export function getMaxEachSteps() { return maxEachSteps; }

/**
 * Set the item budget for this process (tests, a host with its own setting); 0 or Infinity = unlimited.
 * @param {number} n
 */
export function setMaxEachSteps(n) {
    maxEachSteps = (n === 0 || n === Infinity) ? Infinity : Math.max(1, Math.trunc(Number(n) || DEFAULT_MAX_EACH_STEPS));
}

/**
 * Count one visited item against the evaluation's budget; throws past it.
 * @param {{ used: number }} budget
 */
export function tickEach(budget) {
    budget.used += 1;
    if (budget.used > maxEachSteps) {
        throw new ExprLimitError(`List functions visited more than ${maxEachSteps} items in one formula (EXPR_MAX_EACH_STEPS=${maxEachSteps})`);
    }
}
