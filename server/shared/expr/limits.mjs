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

// ── Collections (collections.mjs, the list and object literals) ─────────────

/** range() never builds a longer list. A definition limit, not a budget. */
export const MAX_RANGE_ITEMS = 10_000;

/** How deep list and object literals may nest in one formula. */
export const MAX_LITERAL_DEPTH = 32;

/** How many functions an author may define, and how many parameters one takes. */
export const MAX_USER_FUNCTIONS = 30;
export const MAX_USER_FUNCTION_PARAMS = 8;

/**
 * How many values (a list, an object, and everything inside them, counted as
 * if written out) a literal, a reduce() step or an author's function may
 * produce. `[acc, acc]` in a reduce() doubles what it holds every step while
 * building only one new list, so the item budget alone would not see it. Read
 * once from EXPR_MAX_VALUE_NODES when there is an environment; 0 means unlimited.
 */
export const DEFAULT_MAX_VALUE_NODES = 1_000_000;

let maxValueNodes = readEnvCap('EXPR_MAX_VALUE_NODES', DEFAULT_MAX_VALUE_NODES);

/** The current cap; Infinity when unlimited. */
export function getMaxValueNodes() { return maxValueNodes; }

/**
 * Set the cap for this process (tests, a host with its own setting); 0 or Infinity = unlimited.
 * @param {number} n
 */
export function setMaxValueNodes(n) {
    maxValueNodes = (n === 0 || n === Infinity) ? Infinity : Math.max(1, Math.trunc(Number(n) || DEFAULT_MAX_VALUE_NODES));
}

/** @param {object} v @returns {unknown[]} */
function childrenOf(v) {
    return Array.isArray(v) ? v : Object.values(v);
}

/**
 * The written-out size of a value: 1 for a scalar, 1 plus its children for a
 * list or an object. A list that holds the same object twice counts it twice,
 * but visits it once: `sizes` remembers every list and object already
 * measured, for the whole evaluation (values are never changed after they are
 * built). Iterative, so a deeply nested value cannot exhaust the stack; a
 * value that contains itself counts the inner reference as 0.
 * @param {unknown} value
 * @param {WeakMap<object, number>} sizes
 * @returns {number}
 */
function writtenSize(value, sizes) {
    if (value === null || typeof value !== 'object') return 1;
    const known = sizes.get(value);
    if (known !== undefined) return known;
    /** @type {Array<{ node: object, kids: unknown[], next: number, total: number }>} */
    const stack = [{ node: value, kids: childrenOf(value), next: 0, total: 1 }];
    sizes.set(value, 0);
    let result = 0;
    while (stack.length > 0) {
        const top = /** @type {{ node: object, kids: unknown[], next: number, total: number }} */ (stack[stack.length - 1]);
        if (top.next >= top.kids.length) {
            sizes.set(top.node, top.total);
            stack.pop();
            const parent = stack[stack.length - 1];
            if (parent) parent.total += top.total; else result = top.total;
            continue;
        }
        const kid = top.kids[top.next++];
        if (kid === null || typeof kid !== 'object') { top.total += 1; continue; }
        const seen = sizes.get(kid);
        if (seen !== undefined) { top.total += seen; continue; }
        sizes.set(kid, 0);
        stack.push({ node: kid, kids: childrenOf(kid), next: 0, total: 1 });
    }
    return result;
}

/**
 * The value a literal, a reduce() step or an author's function produced:
 * refused when written out it holds more values than the cap.
 * @template T
 * @param {T} value
 * @param {{ sizes?: WeakMap<object, number> }} budget the evaluation's budget (engine.mjs newEnv)
 * @returns {T}
 */
export function guardSize(value, budget) {
    if (value === null || typeof value !== 'object') return value;
    if (!budget.sizes) budget.sizes = new WeakMap();
    if (writtenSize(value, budget.sizes) > maxValueNodes) {
        throw new ExprLimitError(`A formula built a value of more than ${maxValueNodes} items (EXPR_MAX_VALUE_NODES=${maxValueNodes})`);
    }
    return value;
}
