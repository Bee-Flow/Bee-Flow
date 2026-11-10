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
 *   ternary  := nullish ('?' ternary ':' ternary)?
 *   nullish  := logical_or ('??' logical_or)*
 *   logical_or := logical_and ('||' logical_and)*
 *   logical_and := equality ('&&' equality)*
 *   equality := compare (('=='|'!='|'==='|'!==') compare)*
 *   compare  := additive (('<'|'<='|'>'|'>=') additive)*
 *   additive := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := unary (('*'|'/'|'%') unary)*
 *   unary    := ('!'|'-'|'+') unary | power
 *   power    := primary ('^' unary)?
 *   primary  := number | string | bool | null | (call | each | reduce | list | object | '(' expr ')') segment* | identifier_path
 *   call     := (WHITELISTED_FN | HOST_FN) '(' (expr (',' expr)*)? ')'
 *   each     := ('map'|'filter'|'some'|'every') '(' expr ',' expr ')'
 *   reduce   := 'reduce' '(' expr ',' expr ',' expr ')'
 *   list     := '[' (expr (',' expr)*)? ','? ']'
 *   object   := '{' (key ':' expr (',' key ':' expr)*)? ','? '}'      key := ident | string
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
 * ADDED LATER, each a parse error before it existed, so no stored expression
 * changed meaning: `a ?? b` (b when a is null or missing; binds looser than
 * `||`, tighter than `?:`), list literals `[1, x]`, object literals
 * `{ name: x, "a b": 1 }`, and `reduce(list, expr, start)`, whose second
 * argument reads the item as `it` and the result so far as `acc`. A literal
 * is only a literal where a value starts: after a name or a value `[` is
 * still an index. Literals nest at most MAX_LITERAL_DEPTH deep; what a
 * literal, a reduce() step or an author's function builds is measured
 * (limits.mjs guardSize).
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
 *
 * A host entry with `pure: true` is answered from its arguments alone: it may
 * be used inside map/filter/reduce and inside another call, it is a
 * `usercall` node (collectHostCalls does not list it: there is nothing to ask
 * first), and it either carries `fn` or `{ params, body }`, a parsed
 * expression the engine evaluates with ONLY the parameters in scope. That is
 * how an author's own functions run (userFunctions.mjs builds the table and
 * refuses recursion).
 */

import { FUNCTIONS, EXPR_FUNCTIONS as PLAIN_FUNCTION_DOCS, EXPR_FUNCTION_NAMES as PLAIN_FUNCTION_NAMES } from './functions.mjs';
import { TOKEN, tokenize } from './tokens.mjs';
import { collectRefs, collectHostCalls, collectEachCalls, readsItem, sinceOf } from './astWalk.mjs';
import { checkRegexCall } from './regex.mjs';
import { checkDateUnit } from './dates.mjs';
import { LIST_FUNCTION_DOCS, EACH_FUNCTIONS } from './lists.mjs';
import { COLLECTION_FUNCTION_DOCS, REDUCE_FN } from './collections.mjs';
import { ExprError, MAX_LITERAL_DEPTH } from './limits.mjs';
import { evalNode, newEnv } from './evaluator.mjs';

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
    // > 0 while parsing the second argument of reduce(): `acc` is the result so far there.
    let accDepth = 0;
    let literalDepth = 0;
    const peek = () => tokens[pos];
    const eat = (t) => {
        if (tokens[pos].t !== t) throw new ExprError(`Expected ${t} but got ${tokens[pos].t}`, tokens[pos].i);
        return tokens[pos++];
    };
    const accept = (t) => (tokens[pos].t === t ? tokens[pos++] : null);

    function ternary() {
        const cond = nullish();
        if (accept(TOKEN.QMARK)) {
            const a = ternary();
            eat(TOKEN.COLON);
            const b = ternary();
            return { kind: 'ternary', cond, a, b };
        }
        return cond;
    }
    // `a ?? b`: b when a is null or missing. Looser than `||`, so `a || b ?? c` is `(a || b) ?? c`.
    function nullish() {
        let n = logicalOr();
        while (accept(TOKEN.NULLISH)) n = { kind: 'binop', op: '??', a: n, b: logicalOr() };
        return n;
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
    // reduce(list, expr, start): expr reads the item as `it` and the result so far as `acc`.
    function reduceOf(tk) {
        const usage = `${tk.v}() takes a list, an expression and a start value, like ${tk.v}(list, acc + it.x, 0)`;
        eat(TOKEN.LPAREN);
        const list = ternary();
        if (!accept(TOKEN.COMMA)) throw new ExprError(usage, tk.i);
        eachDepth++; accDepth++;
        const body = ternary();
        eachDepth--; accDepth--;
        if (!accept(TOKEN.COMMA)) throw new ExprError(usage, tk.i);
        const start = ternary();
        if (peek().t !== TOKEN.RPAREN) throw new ExprError(usage, tk.i);
        eat(TOKEN.RPAREN);
        if (collectHostCalls(body).length > 0) {
            throw new ExprError(`${tk.v}(): ${collectHostCalls(body)[0].name}() cannot be used inside the expression of ${tk.v}()`, tk.i);
        }
        return { kind: 'reduce', name: tk.v, args: [list, body, start] };
    }
    // A pure host function (an author's own): any place a plain call may stand.
    function userCallOf(tk, spec) {
        const list = args();
        if (Array.isArray(spec.params) && list.length !== spec.params.length) {
            throw new ExprError(`${tk.v}() takes ${spec.params.length} argument${spec.params.length === 1 ? '' : 's'} (${spec.params.join(', ')})`, tk.i);
        }
        const problem = typeof spec.check === 'function' ? spec.check(list) : null;
        if (problem) throw new ExprError(problem, tk.i);
        return { kind: 'usercall', name: tk.v, args: list };
    }
    // `[a, b]` after its `[`, and `{ k: a }` after its `{`.
    function listLiteral(tk) {
        if (++literalDepth > MAX_LITERAL_DEPTH) throw new ExprError(`Lists and objects nest at most ${MAX_LITERAL_DEPTH} deep`, tk.i);
        const items = [];
        while (peek().t !== TOKEN.RBRACK) {
            items.push(ternary());
            if (!accept(TOKEN.COMMA)) break;
        }
        eat(TOKEN.RBRACK);
        literalDepth--;
        return { kind: 'list', args: items };
    }
    function objectLiteral(tk) {
        if (++literalDepth > MAX_LITERAL_DEPTH) throw new ExprError(`Lists and objects nest at most ${MAX_LITERAL_DEPTH} deep`, tk.i);
        const keys = [];
        const values = [];
        while (peek().t !== TOKEN.RBRACE) {
            const k = peek();
            if (k.t !== TOKEN.IDENT && k.t !== TOKEN.STRING) throw new ExprError('A field name in { } is a name or a text in quotes, like { name: x, "a b": 1 }', k.i);
            pos++;
            if (keys.includes(k.v)) throw new ExprError(`Field "${k.v}" is given twice`, k.i);
            eat(TOKEN.COLON);
            keys.push(k.v);
            values.push(ternary());
            if (!accept(TOKEN.COMMA)) break;
        }
        eat(TOKEN.RBRACE);
        literalDepth--;
        return { kind: 'object', keys, args: values };
    }
    function callOf(tk) {
        // FUNCTIONS wins a name clash, so a host can never change
        // what a whitelisted function means; the list forms come next.
        if (!hasOwn(FUNCTIONS, tk.v) && EACH_NAMES.has(tk.v)) return eachOf(tk);
        if (!hasOwn(FUNCTIONS, tk.v) && tk.v === REDUCE_FN) return reduceOf(tk);
        if (!hasOwn(FUNCTIONS, tk.v) && hasOwn(host, tk.v) && host[tk.v] && host[tk.v].pure === true) return userCallOf(tk, host[tk.v]);
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
        if (tk.t === TOKEN.LBRACK) { pos++; return postfix(listLiteral(tk)); }
        if (tk.t === TOKEN.LBRACE) { pos++; return postfix(objectLiteral(tk)); }
        if (tk.t === TOKEN.IDENT) {
            pos++;
            if (peek().t === TOKEN.LPAREN) return postfix(callOf(tk));
            const local = (tk.v === 'it' && eachDepth > 0) || (tk.v === 'acc' && accDepth > 0);
            const head = local ? { kind: 'local', v: tk.v } : { kind: 'name', v: tk.v };
            return { kind: 'path', segments: [head, ...segments()] };
        }
        throw new ExprError(`Unexpected token: ${tk.t}`, tk.i);
    }

    const ast = ternary();
    if (peek().t !== TOKEN.EOF) throw new ExprError('Trailing tokens in expression', peek().i);
    return ast;
}

// ── Public API ─────────────────────────────────────────
//
// `opts.host` (optional) is the host-function table described in the header.
// Without it every function below behaves exactly as it always has.
// `opts.objects: false` refuses object literals (tokens.mjs).

/** Parse an expression string → AST. Throws ExprError on bad grammar. */
export function parseExpr(src, opts) {
    return parse(tokenize(src, opts), opts?.host || null);
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
const EXPR_FUNCTIONS = [...PLAIN_FUNCTION_DOCS, ...LIST_FUNCTION_DOCS, ...COLLECTION_FUNCTION_DOCS];
const EXPR_FUNCTION_NAMES = [...PLAIN_FUNCTION_NAMES, ...EACH_FUNCTIONS, REDUCE_FN];

/** @type {Map<string, number>} */
const SINCE_BY_NAME = new Map();
for (const doc of COLLECTION_FUNCTION_DOCS) SINCE_BY_NAME.set(doc.name, doc.since);

/**
 * The schema version of the app definition an expression needs: 3 when it
 * uses vocabulary that was a parse error before (literals, `??`, reduce, the
 * collection functions, an author's function), else 0. Takes a source text or
 * a parsed tree; a text that does not parse needs nothing (0).
 */
export function exprSince(src, opts) {
    let ast = src;
    if (typeof src === 'string') {
        try { ast = parseExpr(src, opts); } catch { return 0; }
    }
    return sinceOf(ast, SINCE_BY_NAME);
}

export { FUNCTIONS, EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES, EACH_FUNCTIONS, collectRefs, collectHostCalls, collectEachCalls, readsItem };
