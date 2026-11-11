// @typecheck strict
/**
 * An author's own functions: `[{ name, params, expr }]` turned into the host
 * table the engine accepts (`evaluate(src, scope, { host })`), so a formula
 * can call `fullName(item)` like a built-in one.
 *
 * The rules that keep them as safe as the rest of the language:
 *  - a function reads ONLY its parameters. No scope root, no `it` or `acc` of
 *    the place that calls it: the same arguments give the same answer in the
 *    browser, on the server and on the phone, wherever the call stands;
 *  - no recursion, direct or through another function (checked here, and the
 *    engine stops at MAX_USER_FUNCTIONS calls deep whatever table it is given);
 *  - a name can never replace a built-in function (FUNCTIONS wins in the
 *    parser, and a clash is reported here);
 *  - at most MAX_USER_FUNCTIONS functions of at most MAX_USER_FUNCTION_PARAMS
 *    parameters. Every call counts against the item budget of the evaluation
 *    and its result is measured (limits.mjs).
 *
 * A function with a problem stays in the table as an entry without a body, so
 * a formula that calls it still parses and fails at evaluation with the reason.
 */
import { EXPR_FUNCTION_NAMES, ExprError, collectRefs, parseExpr } from './engine.mjs';
import { collectUserCalls } from './astWalk.mjs';
import { MAX_USER_FUNCTIONS, MAX_USER_FUNCTION_PARAMS } from './limits.mjs';

/**
 * @typedef {{ name?: unknown, params?: unknown, expr?: unknown }} UserFunctionInput
 * @typedef {{ index: number, name: string | null, code: string, message: string }} UserFunctionProblem
 * @typedef {{ pure: true, params: string[], body?: unknown, unanswered?: string }} UserFunctionEntry
 * @typedef {{ index: number, name: string, params: string[], expr: unknown }} Header
 */

/** Words the grammar reads as something else. */
const RESERVED_WORDS = new Set(['true', 'false', 'null', 'it', 'acc']);

/** A letter or underscore, then letters, digits and underscores (ASCII: a name is typed in a formula). @param {unknown} s */
export function isFunctionIdentifier(s) {
    if (typeof s !== 'string' || s.length === 0 || s.length > 40) return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
        const digit = c >= 48 && c <= 57;
        if (!letter && !(digit && i > 0)) return false;
    }
    return true;
}

/**
 * The problem with one function's name and parameters, or null.
 * @param {UserFunctionInput} def @param {Set<string>} taken @param {ReadonlySet<string>} builtIn
 * @returns {{ code: string, message: string } | null}
 */
function headerProblem(def, taken, builtIn) {
    const { name, params } = def;
    if (!isFunctionIdentifier(name) || RESERVED_WORDS.has(/** @type {string} */ (name))) {
        return { code: 'function.name', message: 'A function name starts with a letter and holds only letters, digits and _ (at most 40), and is not true, false, null, it or acc.' };
    }
    const n = /** @type {string} */ (name);
    if (builtIn.has(n)) return { code: 'function.name_taken', message: `${n}() is a built-in function; choose another name.` };
    if (taken.has(n)) return { code: 'function.duplicate', message: `${n}() is defined twice.` };
    if (!Array.isArray(params) || params.length > MAX_USER_FUNCTION_PARAMS) {
        return { code: 'function.params', message: `params is a list of at most ${MAX_USER_FUNCTION_PARAMS} names.` };
    }
    const seen = new Set();
    for (const p of params) {
        if (!isFunctionIdentifier(p) || RESERVED_WORDS.has(p) || seen.has(p)) {
            return { code: 'function.params', message: `${n}(): every parameter is a different name of letters, digits and _ (not true, false, null, it or acc).` };
        }
        seen.add(p);
    }
    return null;
}

/**
 * Parse one body against the table and check what it reads.
 * @param {Header} h @param {Record<string, UserFunctionEntry>} host @param {number | undefined} maxLength
 * @returns {{ ast: unknown, calls: string[] } | { code: string, message: string }}
 */
function parseBody(h, host, maxLength) {
    if (typeof h.expr !== 'string' || h.expr.trim() === '') return { code: 'function.expr', message: `${h.name}() needs an expression.` };
    if (maxLength && h.expr.length > maxLength) return { code: 'function.too_long', message: `${h.name}(): the expression is ${h.expr.length} characters; the maximum is ${maxLength}.` };
    let ast;
    try {
        ast = parseExpr(h.expr, { host });
    } catch (e) {
        const at = e instanceof ExprError && typeof e.index === 'number' ? ` at position ${e.index}` : '';
        return { code: 'function.parse_error', message: `${h.name}() failed to parse${at}: ${e instanceof Error ? e.message : String(e)}.` };
    }
    const outside = [...collectRefs(ast, new Set())].filter((r) => !h.params.includes(r));
    if (outside.length > 0) {
        return { code: 'function.reads_outside', message: `${h.name}() reads ${outside.join(', ')}, which is not one of its parameters. A function reads only its parameters: pass the value in.` };
    }
    return { ast, calls: [...new Set(collectUserCalls(ast).map((c) => c.name))] };
}

/**
 * The names that can reach themselves through the calls.
 * @param {Map<string, string[]>} calls
 * @returns {Set<string>}
 */
function recursiveNames(calls) {
    /** @type {Set<string>} */
    const out = new Set();
    for (const start of calls.keys()) {
        const seen = new Set();
        const todo = [...(calls.get(start) || [])];
        while (todo.length > 0) {
            const name = /** @type {string} */ (todo.pop());
            if (name === start) { out.add(start); break; }
            if (seen.has(name)) continue;
            seen.add(name);
            todo.push(...(calls.get(name) || []));
        }
    }
    return out;
}

/**
 * Turn function definitions into a host table.
 *
 * @param {unknown} defs `[{ name, params: string[], expr }]`
 * @param {{ maxExprLength?: number, reserved?: Iterable<string> }} [opts]
 *   `reserved`: more names a function may not take (the caller's other host functions).
 * @returns {{ host: Record<string, UserFunctionEntry>, problems: UserFunctionProblem[] }}
 *   `host` is safe to pass as `opts.host` even when there are problems.
 */
export function compileUserFunctions(defs, opts = {}) {
    /** @type {Record<string, UserFunctionEntry>} */
    const host = {};
    /** @type {UserFunctionProblem[]} */
    const problems = [];
    if (defs === undefined || defs === null) return { host, problems };
    if (!Array.isArray(defs)) {
        return { host, problems: [{ index: -1, name: null, code: 'function.list', message: 'functions is a list of { name, params, expr }.' }] };
    }
    if (defs.length > MAX_USER_FUNCTIONS) {
        problems.push({ index: -1, name: null, code: 'function.too_many', message: `An app defines at most ${MAX_USER_FUNCTIONS} functions; this one has ${defs.length}.` });
    }
    const builtIn = new Set([...EXPR_FUNCTION_NAMES, ...(opts.reserved || [])]);
    /** @type {Header[]} */
    const headers = [];
    const taken = new Set();
    defs.slice(0, MAX_USER_FUNCTIONS).forEach((raw, index) => {
        /** @type {UserFunctionInput} */
        const def = raw !== null && typeof raw === 'object' ? raw : {};
        const problem = headerProblem(def, taken, builtIn);
        const name = typeof def.name === 'string' ? def.name : null;
        if (problem) { problems.push({ index, name, ...problem }); return; }
        const h = { index, name: /** @type {string} */ (def.name), params: [.../** @type {string[]} */ (def.params)], expr: def.expr };
        taken.add(h.name);
        headers.push(h);
        Object.defineProperty(host, h.name, { value: { pure: true, params: h.params }, enumerable: true, writable: true, configurable: true });
    });
    /** @type {Map<string, string[]>} */
    const calls = new Map();
    /** @param {Header} h @param {string} code @param {string} message */
    const fail = (h, code, message) => {
        problems.push({ index: h.index, name: h.name, code, message });
        /** @type {UserFunctionEntry} */ (host[h.name]).unanswered = message;
    };
    for (const h of headers) {
        const parsed = parseBody(h, host, opts.maxExprLength);
        if ('code' in parsed) { fail(h, parsed.code, parsed.message); continue; }
        /** @type {UserFunctionEntry} */ (host[h.name]).body = parsed.ast;
        calls.set(h.name, parsed.calls);
    }
    const loops = recursiveNames(calls);
    for (const h of headers) {
        if (!loops.has(h.name)) continue;
        delete /** @type {UserFunctionEntry} */ (host[h.name]).body;
        fail(h, 'function.recursive', `${h.name}() ends up calling itself. A function may call other functions, never itself.`);
    }
    problems.sort((a, b) => a.index - b.index);
    return { host, problems };
}
