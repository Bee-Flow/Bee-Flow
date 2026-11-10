// @typecheck
/**
 * Restricted expression evaluator — SHARED between the automation runtime
 * (server) and App Studio (client + server live preview / validation).
 *
 * Ported verbatim from server/automation/expr.js (which now re-exports this) plus: an extended function
 * whitelist (functions.mjs), `compile()` returning the referenced root identifiers for
 * validation-without-execution, and `tryEvaluate()` that never throws (runtime formulas degrade to undefined).
 *
 * We deliberately do NOT use eval/new Function — a tiny recursive-descent parser makes the surface auditable
 * and impossible to smuggle calls/lookups through. The ONLY callable forms are the closed whitelist in
 * FUNCTIONS; any other `ident(` throws at PARSE time. Member access (dot + computed bracket) is prototype-safe
 * (hasOwnProperty gate), so `x["constructor"]` resolves to undefined rather than walking to Function.
 *
 * Grammar:
 *   expr     := ternary
 *   ternary  := logical_or ('?' ternary ':' ternary)?
 *   logical_or := logical_and ('||' logical_and)*
 *   logical_and := equality ('&&' equality)*
 *   equality := compare (('=='|'!='|'==='|'!==') compare)*
 *   compare  := additive (('<'|'<='|'>'|'>=') additive)*
 *   additive := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := unary (('*'|'/'|'%') unary)*
 *   unary    := ('!'|'-'|'+') unary | power
 *   power    := primary ('^' unary)?
 *   primary  := number | string | bool | null | (call | each | '(' expr ')') segment* | identifier_path
 *   call     := (WHITELISTED_FN | HOST_FN) '(' (expr (',' expr)*)? ')'
 *   each     := ('map'|'filter'|'some'|'every') '(' expr ',' expr ')'
 *   identifier_path := ident segment*
 *   segment  := '.' ident | '[' expr ']' | '[*]' | '[' key '=' literal ']'
 *
 * A call result reads on like a path (`find(rows, "id", x).name`,
 * `first(list).y`, `(a || b).name`, `f(x)[0]`): the node becomes a path whose
 * first segment is `{ kind: 'base', expr }`, with the same own-property rules
 * as every other step. A call without segments parses to the same tree as
 * before. In the second argument of map/filter/some/every the name `it` is
 * the item (`{ kind: 'local' }`); everywhere else `it` is an ordinary root.
 *
 * HOST functions. A caller may pass `{ host }` to parseExpr/evaluate/
 * tryEvaluate: a small table of extra callables that only exist where that
 * caller can answer them. `isAbout(item.body, "a complaint")` is the first
 * (see topics.mjs): its answer comes from a classifier the automation runner
 * calls BEFORE the rows are evaluated, so it can never be a pure entry in
 * FUNCTIONS. Everything that does not pass a host (App Studio formulas,
 * bindings, approval and trigger conditions) parses exactly as before, and
 * `isAbout(` there is still an "Unknown function". A host entry is
 * `{ check(args) -> message|null, fn?(...values), unanswered? }`: `check`
 * validates the parsed arguments at parse time, `fn` answers at evaluation
 * time, and a host call evaluated without an `fn` throws `unanswered` instead
 * of guessing.
 */

import { FUNCTIONS, EXPR_FUNCTIONS as PLAIN_FUNCTION_DOCS, EXPR_FUNCTION_NAMES as PLAIN_FUNCTION_NAMES } from './functions.mjs';
import { jsonCacheFor, stepInto, stepMatch, walkTokens } from './path.mjs';
import { TOKEN, tokenize } from './tokens.mjs';
import { collectRefs, collectHostCalls, collectEachCalls, readsItem } from './astWalk.mjs';
import { checkRegexCall } from './regex.mjs';
import { checkDateUnit } from './dates.mjs';
import { LIST_FUNCTION_DOCS, EACH_FUNCTIONS } from './lists.mjs';
import { ExprError, guardValue, tickEach } from './limits.mjs';

export { ExprError }; // defined in limits.mjs so the functions can throw it

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

/** @type {ReadonlySet<string>} */
const EACH_NAMES = new Set(EACH_FUNCTIONS);

/** The parse-time argument checks of a plain call (literal date unit, literal regex). */
function checkCallArgs(tk, args) {
    return checkRegexCall(tk, checkDateUnit(tk, args, ExprError), ExprError);
}

// ── Parser (recursive descent) ─────────────────────────
function parse(tokens, host) {
    let pos = 0;
    // > 0 while parsing the second argument of map/filter/some/every: `it` is the item there.
    let eachDepth = 0;
    const peek = () => tokens[pos];
    const eat = (t) => {
        if (tokens[pos].t !== t) throw new ExprError(`Expected ${t} but got ${tokens[pos].t}`, tokens[pos].i);
        return tokens[pos++];
    };
    const accept = (t) => (tokens[pos].t === t ? tokens[pos++] : null);

    function ternary() {
        const cond = logicalOr();
        if (accept(TOKEN.QMARK)) {
            const a = ternary();
            eat(TOKEN.COLON);
            const b = ternary();
            return { kind: 'ternary', cond, a, b };
        }
        return cond;
    }
    function logicalOr() {
        let n = logicalAnd();
        while (accept(TOKEN.OR)) n = { kind: 'binop', op: '||', a: n, b: logicalAnd() };
        return n;
    }
    function logicalAnd() {
        let n = equality();
        while (accept(TOKEN.AND)) n = { kind: 'binop', op: '&&', a: n, b: equality() };
        return n;
    }
    function equality() {
        let n = compare();
        while (true) {
            if (accept(TOKEN.SEQ)) n = { kind: 'binop', op: '===', a: n, b: compare() };
            else if (accept(TOKEN.SNEQ)) n = { kind: 'binop', op: '!==', a: n, b: compare() };
            else if (accept(TOKEN.EQ)) n = { kind: 'binop', op: '==', a: n, b: compare() };
            else if (accept(TOKEN.NEQ)) n = { kind: 'binop', op: '!=', a: n, b: compare() };
            else break;
        }
        return n;
    }
    function compare() {
        let n = additive();
        while (true) {
            if (accept(TOKEN.LTE)) n = { kind: 'binop', op: '<=', a: n, b: additive() };
            else if (accept(TOKEN.GTE)) n = { kind: 'binop', op: '>=', a: n, b: additive() };
            else if (accept(TOKEN.LT)) n = { kind: 'binop', op: '<', a: n, b: additive() };
            else if (accept(TOKEN.GT)) n = { kind: 'binop', op: '>', a: n, b: additive() };
            else break;
        }
        return n;
    }
    function additive() {
        let n = multiplicative();
        while (true) {
            if (accept(TOKEN.PLUS)) n = { kind: 'binop', op: '+', a: n, b: multiplicative() };
            else if (accept(TOKEN.MINUS)) n = { kind: 'binop', op: '-', a: n, b: multiplicative() };
            else break;
        }
        return n;
    }
    function multiplicative() {
        let n = unary();
        while (true) {
            if (accept(TOKEN.STAR)) n = { kind: 'binop', op: '*', a: n, b: unary() };
            else if (accept(TOKEN.SLASH)) n = { kind: 'binop', op: '/', a: n, b: unary() };
            else if (accept(TOKEN.PERCENT)) n = { kind: 'binop', op: '%', a: n, b: unary() };
            else break;
        }
        return n;
    }
    function unary() {
        if (accept(TOKEN.BANG)) return { kind: 'unop', op: '!', a: unary() };
        if (accept(TOKEN.MINUS)) return { kind: 'unop', op: '-', a: unary() };
        if (accept(TOKEN.PLUS)) return { kind: 'unop', op: '+', a: unary() };
        return power();
    }
    // `^` — exponent. Two decisions, both pinned by the golden corpus:
    //
    //  1. RIGHT-ASSOCIATIVE: `2 ^ 3 ^ 2` is 2^(3^2) = 512, not (2^3)^2 = 64.
    //     That is how the operator reads in maths, in Python and in JS's `**`.
    //     It falls out of recursing into unary() (not power()) on the right,
    //     which also makes `2 ^ -2` = 0.25 parse without brackets.
    //
    //  2. BINDS TIGHTER THAN UNARY MINUS: `-2 ^ 2` is -(2^2) = -4, not
    //     (-2)^2 = 4. This is the classic trap — it is why `power` is entered
    //     FROM unary() and calls primary() directly, rather than sitting
    //     between multiplicative and unary. Same answer as Python; JS makes
    //     `-2 ** 2` a syntax error rather than choose, which is not an option
    //     for a formula field a non-programmer types into. Write `(-2) ^ 2`
    //     for the other reading.
    //
    // Multiplication still binds looser (`2 * 3 ^ 2` = 18) and the operator
    // evaluates through FUNCTIONS.pow, so `^` and pow() cannot ever disagree.
    function power() {
        const base = primary();
        if (accept(TOKEN.CARET)) return { kind: 'binop', op: '^', a: base, b: unary() };
        return base;
    }
    function args() {
        eat(TOKEN.LPAREN);
        const out = [];
        if (peek().t !== TOKEN.RPAREN) {
            out.push(ternary());
            while (accept(TOKEN.COMMA)) out.push(ternary());
        }
        eat(TOKEN.RPAREN);
        return out;
    }
    // map/filter/some/every: exactly a list and a body; the body reads the item as `it`.
    function eachOf(tk) {
        eat(TOKEN.LPAREN);
        const list = ternary();
        if (!accept(TOKEN.COMMA)) throw new ExprError(`${tk.v}() takes a list and an expression, like ${tk.v}(list, it.x)`, tk.i);
        eachDepth++;
        const body = ternary();
        eachDepth--;
        if (peek().t !== TOKEN.RPAREN) throw new ExprError(`${tk.v}() takes exactly two arguments: a list and an expression`, tk.i);
        eat(TOKEN.RPAREN);
        if (collectHostCalls(body).length > 0) {
            throw new ExprError(`${tk.v}(): ${collectHostCalls(body)[0].name}() cannot be used inside the expression of ${tk.v}()`, tk.i);
        }
        return { kind: 'each', name: tk.v, args: [list, body] };
    }
    function callOf(tk) {
        // FUNCTIONS wins a name clash, so a host can never change
        // what a whitelisted function means; the list forms come next.
        if (!hasOwn(FUNCTIONS, tk.v) && EACH_NAMES.has(tk.v)) return eachOf(tk);
        const spec = !hasOwn(FUNCTIONS, tk.v) && hasOwn(host, tk.v) ? host[tk.v] : null;
        if (!spec && !hasOwn(FUNCTIONS, tk.v)) {
            throw new ExprError(`Unknown function: ${tk.v}`, tk.i);
        }
        const list = args();
        if (!spec) return { kind: 'call', name: tk.v, args: checkCallArgs(tk, list) };
        // A host call inside another host call's arguments would need
        // its own answer before the caller could collect what to ask.
        if (list.some((a) => collectHostCalls(a).length > 0)) {
            throw new ExprError(`${tk.v}() cannot be used inside another ${tk.v}()`, tk.i);
        }
        const problem = typeof spec.check === 'function' ? spec.check(list) : null;
        if (problem) throw new ExprError(problem, tk.i);
        return { kind: 'hostcall', name: tk.v, args: list };
    }
    /** The `.key`, `[expr]`, `[*]` and `[key=literal]` steps after a name or a value. */
    function segments() {
        /** @type {Array<{ kind: string, [field: string]: any }>} */
        const path = [];
        while (true) {
            if (accept(TOKEN.DOT)) {
                const id = eat(TOKEN.IDENT);
                path.push({ kind: 'name', v: id.v });
            } else if (accept(TOKEN.LBRACK)) {
                path.push(bracketSegment());
            } else break;
        }
        return path;
    }
    // After the `[`: one bracket step, up to and including its `]`.
    function bracketSegment() {
        // `[*]` wildcard — same flatten-map semantics as the
        // binding resolver's walkPath, so a picker-inserted path
        // like `steps.x.output.results[*].subject` evaluates to
        // the array of subjects instead of throwing
        // "Unexpected token: *" (which conditions swallowed into a
        // silent `false` → wrong branch).
        if (peek().t === TOKEN.STAR) {
            eat(TOKEN.STAR);
            eat(TOKEN.RBRACK);
            return { kind: 'wildcard' };
        }
        if ((peek().t === TOKEN.IDENT || peek().t === TOKEN.STRING) && tokens[pos + 1]?.t === TOKEN.ASSIGN) {
            return matchSegment();
        }
        if (peek().t === TOKEN.NUMBER && /^[0-9]+$/.test(peek().raw || '') && !Number.isSafeInteger(peek().v) && tokens[pos + 1]?.t === TOKEN.RBRACK) {
            // A digit key past 2^53 (a snowflake id) would round as
            // a number; read it as the key it spells, as path.mjs does.
            const key = tokens[pos++].raw;
            eat(TOKEN.RBRACK);
            return { kind: 'index', expr: { kind: 'str', v: key } };
        }
        const idx = ternary();
        eat(TOKEN.RBRACK);
        return { kind: 'index', expr: idx };
    }
    // `[key="value"]` — the first element whose key equals
    // the literal (path.mjs stepMatch), so a picked
    // `headers[name="Subject"].value` reads the same here.
    function matchSegment() {
        const key = tokens[pos++].v;
        eat(TOKEN.ASSIGN);
        const neg = accept(TOKEN.MINUS);
        const lit = tokens[pos++];
        let value;
        if (lit.t === TOKEN.NUMBER) value = neg ? -lit.v : lit.v;
        else if (!neg && lit.t === TOKEN.STRING) value = lit.v;
        else if (!neg && lit.t === TOKEN.BOOL) value = lit.v;
        else if (!neg && lit.t === TOKEN.NULL) value = null;
        else throw new ExprError('Expected a text, number, true, false or null after =', lit.i);
        eat(TOKEN.RBRACK);
        return { kind: 'match', key, value };
    }
    // A value read on like a path: `first(x).y`, `(a || b).name`, `f(x)[0]`.
    // Without a segment the node is returned as it was parsed.
    function postfix(node) {
        const rest = segments();
        return rest.length ? { kind: 'path', segments: [{ kind: 'base', expr: node }, ...rest] } : node;
    }
    function primary() {
        const tk = peek();
        if (tk.t === TOKEN.NUMBER) { pos++; return { kind: 'num', v: tk.v }; }
        if (tk.t === TOKEN.STRING) { pos++; return { kind: 'str', v: tk.v, raw: tk.raw }; }
        if (tk.t === TOKEN.BOOL) { pos++; return { kind: 'bool', v: tk.v }; }
        if (tk.t === TOKEN.NULL) { pos++; return { kind: 'null' }; }
        if (tk.t === TOKEN.LPAREN) { pos++; const e = ternary(); eat(TOKEN.RPAREN); return postfix(e); }
        if (tk.t === TOKEN.IDENT) {
            pos++;
            if (peek().t === TOKEN.LPAREN) return postfix(callOf(tk));
            const head = tk.v === 'it' && eachDepth > 0 ? { kind: 'local', v: 'it' } : { kind: 'name', v: tk.v };
            return { kind: 'path', segments: [head, ...segments()] };
        }
        throw new ExprError(`Unexpected token: ${tk.t}`, tk.i);
    }

    const ast = ternary();
    if (peek().t !== TOKEN.EOF) throw new ExprError('Trailing tokens in expression', peek().i);
    return ast;
}

// ── Evaluator ──────────────────────────────────────────
/**
 * The evaluation environment: the host table, the item of the innermost
 * map/filter/some/every (`it`), and the item budget shared by the whole
 * evaluation (limits.mjs tickEach).
 * @typedef {{ host: Record<string, { fn?: (...args: unknown[]) => unknown, unanswered?: string }> | null, it: unknown, budget: { used: number } }} EvalEnv
 */

function walkPath(segments, runState, env) {
    const head = segments[0];
    // A call result or a parenthesised value read on like a path (`base`),
    // or `it` inside map/filter/some/every (`local`): the walk starts there.
    if (head && head.kind === 'base') return walkFrom(evalNode(head.expr, runState, env), segments, 1, runState, env);
    if (head && head.kind === 'local') return walkFrom(env.it, segments, 1, runState, env);
    return walkFrom(runState, segments, 0, runState, env);
}

function walkFrom(start, segments, from, runState, env) {
    let cur = start;
    const cache = jsonCacheFor(runState);
    for (let i = from; i < segments.length; i++) {
        if (cur == null) return undefined;
        const s = segments[i];
        if (s.kind === 'name') {
            // One step, with the binding resolver's exact rules (path.mjs
            // stepInto): own properties only, so a string's own members
            // (`.length`, `[0]`) resolve while prototype members
            // (`.toUpperCase`, `.constructor`) come back undefined; JSON text
            // is read as the object it encodes; `[-1]` is the last element.
            cur = stepInto(cur, s.v, cache);
        } else if (s.kind === 'wildcard') {
            // `[*]`: hand the remainder to the shared walker, so the same path
            // string means the same list in a binding and in an expression
            // (flatten what the rest produced by one level, keep explicit
            // nulls, a trailing [*] is the list itself). A computed index in
            // the remainder reads the run state, not the element, so it is
            // evaluated once up front.
            const rest = segments.slice(i + 1);
            const tokens = [];
            for (const r of rest) {
                if (r.kind === 'name') tokens.push({ type: 'prop', key: r.v });
                else if (r.kind === 'wildcard') tokens.push({ type: 'wild' });
                else if (r.kind === 'match') tokens.push({ type: 'match', key: r.key, value: r.value });
                else tokens.push({ type: 'prop', key: evalNode(r.expr, runState, env) });
            }
            return walkTokens([{ type: 'wild' }, ...tokens], cur);
        } else if (s.kind === 'match') {
            cur = stepMatch(cur, s.key, s.value, cache);
        } else if (s.kind === 'root') {
            // Internal marker kept for callers that seed a walk at a value.
            cur = s.v;
        } else {
            const k = evalNode(s.expr, runState, env);
            if (cur == null) return undefined;
            // Same gate as the dot branch: x["constructor"] stays undefined,
            // `name[0]` on a string works exactly as it does in a ref binding.
            if (typeof k !== 'string' && typeof k !== 'number') return undefined;
            cur = stepInto(cur, k, cache);
        }
    }
    return cur;
}

function evalNode(n, ctx, env) {
    switch (n.kind) {
        case 'num': return n.v;
        case 'str': return n.v;
        case 'bool': return n.v;
        case 'null': return null;
        case 'path': return walkPath(n.segments, ctx, env);
        case 'each': return evalEach(n, ctx, env);
        case 'call': {
            const fn = FUNCTIONS[n.name];
            if (!fn) throw new ExprError(`Unknown function: ${n.name}`);
            // Every produced text passes the cap (limits.mjs).
            return guardValue(fn(...n.args.map((a) => evalNode(a, ctx, env))));
        }
        case 'hostcall': {
            const h = hasOwn(env.host, n.name) ? env.host[n.name] : null;
            if (!h || typeof h.fn !== 'function') {
                throw new ExprError(h?.unanswered || `${n.name}() has no answer here`);
            }
            return guardValue(h.fn(...n.args.map((a) => evalNode(a, ctx, env))));
        }
        case 'unop': {
            const v = evalNode(n.a, ctx, env);
            if (n.op === '!') return !v;
            if (n.op === '-') return -v;
            if (n.op === '+') return +v;
            return undefined;
        }
        case 'binop': {
            if (n.op === '&&') return evalNode(n.a, ctx, env) && evalNode(n.b, ctx, env);
            if (n.op === '||') return evalNode(n.a, ctx, env) || evalNode(n.b, ctx, env);
            const a = evalNode(n.a, ctx, env);
            const b = evalNode(n.b, ctx, env);
            switch (n.op) {
                case '+': return guardValue(a + b); // a text `+` grows like concat(): same cap
                case '-': return a - b;
                case '*': return a * b;
                case '/': return a / b;
                case '%': return a % b;
                // `^` IS pow() — one implementation, so the operator inherits
                // its totality (2 ^ 10000 → null, not Infinity) and can never
                // drift from the function form the builder also emits.
                case '^': return FUNCTIONS.pow(a, b);
                case '==': return a == b;
                case '!=': return a != b;
                case '===': return a === b;
                case '!==': return a !== b;
                case '<': return a < b;
                case '<=': return a <= b;
                case '>': return a > b;
                case '>=': return a >= b;
                default: throw new ExprError(`Unknown operator: ${n.op}`);
            }
        }
        case 'ternary': return evalNode(n.cond, ctx, env) ? evalNode(n.a, ctx, env) : evalNode(n.b, ctx, env);
        default: throw new ExprError(`Unknown node kind: ${n.kind}`);
    }
}

/**
 * map/filter/some/every: the body once per item, with the item as `it`.
 * Not a list gives [] (map, filter) or false (some, every); every() of an
 * empty list is false, like everyOf().
 */
function evalEach(n, ctx, env) {
    const list = evalNode(n.args[0], ctx, env);
    const body = n.args[1];
    const many = n.name === 'map' || n.name === 'filter';
    if (!Array.isArray(list)) return many ? [] : false;
    const out = [];
    for (const item of list) {
        tickEach(env.budget);
        const v = evalNode(body, ctx, { host: env.host, it: item, budget: env.budget });
        if (n.name === 'map') out.push(v);
        else if (n.name === 'filter') { if (v) out.push(item); }
        else if (n.name === 'some') { if (v) return true; }
        else if (!v) return false;
    }
    if (many) return out;
    return n.name === 'every' && list.length > 0;
}

/** A fresh environment for one evaluation. @returns {EvalEnv} */
function newEnv(host) {
    return { host: host || null, it: undefined, budget: { used: 0 } };
}

// ── Public API ─────────────────────────────────────────
//
// `opts.host` (optional) is the host-function table described in the header.
// Without it every function below behaves exactly as it always has.

/** Parse an expression string → AST. Throws ExprError on bad grammar. */
export function parseExpr(src, opts) {
    return parse(tokenize(src), opts?.host || null);
}

/** Parse + collect referenced roots WITHOUT executing. Throws on bad grammar. */
export function compile(src, opts) {
    const ast = parseExpr(src, opts);
    return { ast, refs: [...collectRefs(ast, new Set())] };
}

/**
 * Compile (if given a string) and evaluate against a scope root object.
 * Throws ExprError on bad grammar — automation callers rely on this to record
 * evaluation errors, so behavior is byte-identical to the original expr.js.
 */
export function evaluate(src, scope, opts) {
    const ast = typeof src === 'string' ? parseExpr(src, opts) : src;
    return evalNode(ast, scope || {}, newEnv(opts?.host));
}

/**
 * Safe evaluate for App Studio runtime formulas — NEVER throws. A parse or
 * eval failure returns `{ value: undefined, error }` so a bad formula degrades
 * to an empty value + an inspector badge rather than blanking a screen.
 */
export function tryEvaluate(src, scope, opts) {
    try {
        return { value: evaluate(src, scope, opts), error: null };
    } catch (e) {
        return { value: undefined, error: e instanceof Error ? e.message : String(e) };
    }
}

// The whole vocabulary: FUNCTIONS plus the list forms (functions.mjs's own
// lists hold the plain functions only).
const EXPR_FUNCTIONS = [...PLAIN_FUNCTION_DOCS, ...LIST_FUNCTION_DOCS];
const EXPR_FUNCTION_NAMES = [...PLAIN_FUNCTION_NAMES, ...EACH_FUNCTIONS];

export { FUNCTIONS, EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES, EACH_FUNCTIONS, collectRefs, collectHostCalls, collectEachCalls, readsItem };
