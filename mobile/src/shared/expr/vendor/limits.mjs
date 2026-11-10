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
 * @param {{ used: number, work?: number, full?: boolean }} budget
 */
export function tickEach(budget) {
    budget.used += 1;
    if (budget.used > maxEachSteps) {
        throw new ExprLimitError(`List functions visited more than ${maxEachSteps} items in one formula (EXPR_MAX_EACH_STEPS=${maxEachSteps})`);
    }
    if (budget.full) spend(budget, 1);
}

// ── The work budget of one evaluation ────────────────────────────────────────

/**
 * How much ONE evaluation may produce, counted over everything in it: 1 per
 * item a list form visits (so a map or filter result is counted as it is
 * built), 1 plus its length for every list or object a function or a literal
 * hands back, and 1 per TEXT_CHARS_PER_UNIT characters of every text a
 * function or `+` hands back. Each of those is small on its own (a text and a
 * range() have their own ceilings); the budget is what stops them multiplying
 * inside each other. Reading the scope is not counted, and neither is a value
 * a function hands back as it got it (default(x, y) is x or y).
 *
 * The budget applies to a formula that uses something the language gained
 * with the collection functions (`budget.full`, set by engine.mjs evaluate):
 * range() and the literals are what makes a large list out of nothing. A
 * formula written in the earlier language can only multiply what its scope
 * already holds, and keeps exactly the limits it always had (the visited
 * items, the text cap), so no stored formula starts to fail on large data. Read once from EXPR_MAX_WORK when there is an environment; 0
 * means unlimited.
 */
export const DEFAULT_MAX_WORK = 10_000_000;

/** A produced text costs one unit per this many characters. */
export const TEXT_CHARS_PER_UNIT = 16;

let maxWork = readEnvCap('EXPR_MAX_WORK', DEFAULT_MAX_WORK);

/** The current work budget per evaluation; Infinity when unlimited. */
export function getMaxWork() { return maxWork; }

/**
 * Set the work budget for this process (tests, a host with its own setting); 0 or Infinity = unlimited.
 * @param {number} n
 */
export function setMaxWork(n) {
    maxWork = (n === 0 || n === Infinity) ? Infinity : Math.max(1, Math.trunc(Number(n) || DEFAULT_MAX_WORK));
}

/**
 * Count `units` against the evaluation's work budget; throws past it.
 * @param {{ work?: number }} budget @param {number} units
 */
export function spend(budget, units) {
    budget.work = (budget.work || 0) + units;
    if (budget.work > maxWork) {
        throw new ExprLimitError(`One formula produced more than ${maxWork} items (EXPR_MAX_WORK=${maxWork})`);
    }
}

/**
 * The value a function, a literal or `+` produced, counted against the work
 * budget: a text by its length, a list or an object by its own length (what
 * is inside was counted when it was built, or was read from the scope).
 * @template T
 * @param {T} value
 * @param {{ work?: number, full?: boolean }} budget
 * @param {number} [extra] units the caller knows were built besides (groupBy's item lists)
 * @returns {T}
 */
export function spendOn(value, budget, extra = 0) {
    if (!budget.full) return value;
    if (typeof value === 'string') spend(budget, Math.ceil(value.length / TEXT_CHARS_PER_UNIT) + extra);
    else if (Array.isArray(value)) spend(budget, 1 + value.length + extra);
    else if (value !== null && typeof value === 'object') spend(budget, 1 + Object.keys(value).length + extra);
    return value;
}

/**
 * How deep a value a formula builds may nest (a list in a list in an object
 * …). Checked where a value can grow from its own earlier result: a literal,
 * a reduce() step, an author's function. Read once from EXPR_MAX_VALUE_DEPTH
 * when there is an environment; 0 means unlimited.
 */
export const DEFAULT_MAX_VALUE_DEPTH = 100;

let maxValueDepth = readEnvCap('EXPR_MAX_VALUE_DEPTH', DEFAULT_MAX_VALUE_DEPTH);

/** The current depth limit; Infinity when unlimited. */
export function getMaxValueDepth() { return maxValueDepth; }

/**
 * Set the depth limit for this process (tests, a host with its own setting); 0 or Infinity = unlimited.
 * @param {number} n
 */
export function setMaxValueDepth(n) {
    maxValueDepth = (n === 0 || n === Infinity) ? Infinity : Math.max(1, Math.trunc(Number(n) || DEFAULT_MAX_VALUE_DEPTH));
}

/**
 * What an evaluation hands on when the runtime itself gave up (a stack that
 * ran out on a deeply nested value or formula, a text or list past what the
 * runtime can hold): the same error a limit throws, never a bare RangeError.
 * @param {unknown} e @returns {unknown}
 */
export function asLimitError(e) {
    return e instanceof RangeError ? new ExprLimitError('The formula nests too deep or builds a value too large') : e;
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
 * @typedef {{ size: number, depth: number }} Measure
 * @typedef {{ node: object, kids: unknown[], next: number, size: number, depth: number }} Frame
 */

/** @type {Measure} */
const SCALAR = { size: 1, depth: 0 };
/** @type {Measure} */
const PENDING = { size: 0, depth: 0 };

/**
 * The written-out size and the depth of a value: size 1 and depth 0 for a
 * scalar; 1 plus its children, and one deeper than its deepest child, for a
 * list or an object. A list that holds the same object twice counts it
 * twice, but visits it once: `sizes` remembers every list and object already
 * measured, for the whole evaluation (values are never changed after they are
 * built). Iterative, so a deeply nested value cannot exhaust the stack; a
 * value that contains itself counts the inner reference as nothing.
 * @param {unknown} value
 * @param {WeakMap<object, Measure>} sizes
 * @returns {Measure}
 */
function measure(value, sizes) {
    if (value === null || typeof value !== 'object') return SCALAR;
    const known = sizes.get(value);
    if (known !== undefined) return known;
    /** @type {Frame[]} */
    const stack = [{ node: value, kids: childrenOf(value), next: 0, size: 1, depth: 1 }];
    sizes.set(value, PENDING);
    /** @type {Measure} */
    let result = PENDING;
    while (stack.length > 0) {
        const top = /** @type {Frame} */ (stack[stack.length - 1]);
        if (top.next >= top.kids.length) {
            const done = { size: top.size, depth: top.depth };
            sizes.set(top.node, done);
            stack.pop();
            const parent = stack[stack.length - 1];
            if (parent) { parent.size += done.size; parent.depth = Math.max(parent.depth, done.depth + 1); } else result = done;
            continue;
        }
        const kid = top.kids[top.next++];
        if (kid === null || typeof kid !== 'object') { top.size += 1; continue; }
        const seen = sizes.get(kid);
        if (seen !== undefined) { top.size += seen.size; top.depth = Math.max(top.depth, seen.depth + 1); continue; }
        sizes.set(kid, PENDING);
        stack.push({ node: kid, kids: childrenOf(kid), next: 0, size: 1, depth: 1 });
    }
    return result;
}

/**
 * The value a literal, a reduce() step or an author's function produced:
 * refused when written out it holds more values than the cap, or nests
 * deeper than the depth limit.
 * @template T
 * @param {T} value
 * @param {{ sizes?: WeakMap<object, Measure> }} budget the evaluation's budget (evaluator.mjs newEnv)
 * @returns {T}
 */
export function guardSize(value, budget) {
    if (value === null || typeof value !== 'object') return value;
    if (!budget.sizes) budget.sizes = new WeakMap();
    const { size, depth } = measure(value, budget.sizes);
    if (size > maxValueNodes) {
        throw new ExprLimitError(`A formula built a value of more than ${maxValueNodes} items (EXPR_MAX_VALUE_NODES=${maxValueNodes})`);
    }
    if (depth > maxValueDepth) {
        throw new ExprLimitError(`A formula built a value nested more than ${maxValueDepth} deep (EXPR_MAX_VALUE_DEPTH=${maxValueDepth})`);
    }
    return value;
}
