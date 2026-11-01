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

function readEnvCap() {
    const raw = globalThis.process?.env?.EXPR_MAX_TEXT_CHARS;
    if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_TEXT_CHARS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_TEXT_CHARS;
    return n === 0 ? Infinity : Math.trunc(n);
}

let maxTextChars = readEnvCap();

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
