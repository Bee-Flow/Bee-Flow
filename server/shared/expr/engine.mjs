/**
 * Restricted expression evaluator — SHARED between the automation runtime
 * (server) and App Studio (client + server live preview / validation).
 *
 * Ported verbatim from server/automation/expr.js (which now re-exports this)
 * plus: an extended function whitelist (functions.mjs), `compile()` returning
 * the referenced root identifiers for validation-without-execution, and
 * `tryEvaluate()` that never throws (runtime formulas degrade to undefined).
 *
 * We deliberately do NOT use eval/new Function — a tiny recursive-descent
 * parser makes the surface auditable and impossible to smuggle calls/lookups
 * through. The ONLY callable forms are the closed whitelist in FUNCTIONS; any
 * other `ident(` throws at PARSE time. Member access (dot + computed bracket)
 * is prototype-safe (hasOwnProperty gate), so `x["constructor"]` resolves to
 * undefined rather than walking to Function.
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
 *   primary  := number | string | bool | null | call | identifier_path | '(' expr ')'
 *   call     := (WHITELISTED_FN | HOST_FN) '(' (expr (',' expr)*)? ')'
 *   identifier_path := ident ('.' ident | '[' expr ']' | '[*]' | '[' key '=' literal ']')*
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

import { FUNCTIONS, EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES } from './functions.mjs';
import { jsonCacheFor, stepInto, stepMatch, walkTokens } from './path.mjs';

export class ExprError extends Error {
    constructor(message, index) { super(message); this.name = 'ExprError'; this.index = index; }
}

// ── Tokenizer ──────────────────────────────────────────
const TOKEN = {
    NUMBER: 'NUM', STRING: 'STR', IDENT: 'ID', BOOL: 'BOOL', NULL: 'NULL',
    LPAREN: '(', RPAREN: ')', LBRACK: '[', RBRACK: ']',
    DOT: '.', COMMA: ',', QMARK: '?', COLON: ':',
    OR: '||', AND: '&&', EQ: '==', NEQ: '!=', SEQ: '===', SNEQ: '!==',
    LT: '<', LTE: '<=', GT: '>', GTE: '>=',
    PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/', PERCENT: '%', CARET: '^',
    BANG: '!', ASSIGN: '=', EOF: 'EOF',
};

function tokenize(src) {
    if (typeof src !== 'string') throw new ExprError('Expression must be a string', 0);
    const tokens = [];
    let i = 0;
    let brackets = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        const prev = tokens[tokens.length - 1];
        const memberDot = c === '.' && prev && (prev.t === TOKEN.IDENT || prev.t === TOKEN.RBRACK);
        if (memberDot) { tokens.push({ t: TOKEN.DOT, i }); i++; continue; }
        // Right after a member dot, a name is a KEY whatever it looks like:
        // `items.0.subject` (digits), `flags.true`, `naam.prénom`. The same
        // spellings a ref binding resolves (path.mjs), so a picked path never
        // works in a field and breaks in a formula.
        const afterDot = tokens.length > 0 && tokens[tokens.length - 1].t === TOKEN.DOT;
        if (afterDot && /[\p{L}\p{N}_$]/u.test(c)) {
            let j = i;
            while (j < src.length && /[\p{L}\p{N}\p{M}_$]/u.test(src[j])) j++;
            tokens.push({ t: TOKEN.IDENT, v: src.slice(i, j), i });
            i = j; continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
            let j = i;
            while (j < src.length && /[0-9.]/.test(src[j])) j++;
            tokens.push({ t: TOKEN.NUMBER, v: parseFloat(src.slice(i, j)), raw: src.slice(i, j), i });
            i = j; continue;
        }
        if (c === '"' || c === "'") {
            const q = c; let j = i + 1; let out = '';
            while (j < src.length && src[j] !== q) {
                if (src[j] === '\\' && j + 1 < src.length) {
                    const n = src[j + 1];
                    // JSON's escapes, so a key the builder quoted with
                    // JSON.stringify (path.mjs formatKey) reads back here too.
                    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
                        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
                        j += 6;
                        continue;
                    }
                    out += (n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'b' ? '\b' : n === 'f' ? '\f' : n);
                    j += 2;
                } else { out += src[j]; j++; }
            }
            if (j >= src.length) throw new ExprError('Unterminated string in expression', i);
            tokens.push({ t: TOKEN.STRING, v: out, i });
            i = j + 1; continue;
        }
        if (/[\p{L}_$]/u.test(c)) {
            let j = i;
            while (j < src.length && /[\p{L}\p{N}\p{M}_$]/u.test(src[j])) j++;
            const word = src.slice(i, j);
            if (word === 'true' || word === 'false') tokens.push({ t: TOKEN.BOOL, v: word === 'true', i });
            else if (word === 'null') tokens.push({ t: TOKEN.NULL, i });
            else tokens.push({ t: TOKEN.IDENT, v: word, i });
            i = j; continue;
        }
        const two = src.slice(i, i + 2);
        const three = src.slice(i, i + 3);
        if (three === '===') { tokens.push({ t: TOKEN.SEQ, i }); i += 3; continue; }
        if (three === '!==') { tokens.push({ t: TOKEN.SNEQ, i }); i += 3; continue; }
        if (two === '||') { tokens.push({ t: TOKEN.OR, i }); i += 2; continue; }
        if (two === '&&') { tokens.push({ t: TOKEN.AND, i }); i += 2; continue; }
        if (two === '==') { tokens.push({ t: TOKEN.EQ, i }); i += 2; continue; }
        if (two === '!=') { tokens.push({ t: TOKEN.NEQ, i }); i += 2; continue; }
        if (two === '<=') { tokens.push({ t: TOKEN.LTE, i }); i += 2; continue; }
        if (two === '>=') { tokens.push({ t: TOKEN.GTE, i }); i += 2; continue; }
        const single = {
            '(': TOKEN.LPAREN, ')': TOKEN.RPAREN, '[': TOKEN.LBRACK, ']': TOKEN.RBRACK,
            '.': TOKEN.DOT, ',': TOKEN.COMMA, '?': TOKEN.QMARK, ':': TOKEN.COLON,
            '<': TOKEN.LT, '>': TOKEN.GT, '+': TOKEN.PLUS, '-': TOKEN.MINUS,
            '*': TOKEN.STAR, '/': TOKEN.SLASH, '%': TOKEN.PERCENT, '!': TOKEN.BANG,
            // `^` is EXPONENT here, not bitwise XOR. The grammar has no bitwise
            // operators at all, so there is nothing to collide with, and every
            // non-programmer who types 2^10 means 1024. Before this it was an
            // "Unexpected character", so no stored expression can contain one.
            '^': TOKEN.CARET,
        };
        // A single `=` only exists inside a path's brackets, as the match
        // segment `headers[name="Subject"]` (path.mjs). Anywhere else it is
        // still the old error, so `a = b` keeps telling the author to write ==.
        if (c === '=' && brackets > 0) { tokens.push({ t: TOKEN.ASSIGN, i }); i++; continue; }
        if (c === '[') brackets++;
        else if (c === ']' && brackets > 0) brackets--;
        if (single[c]) { tokens.push({ t: single[c], i }); i++; continue; }
        throw new ExprError(`Unexpected character in expression: ${c}`, i);
    }
    tokens.push({ t: TOKEN.EOF, i: src.length });
    return tokens;
}

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// ── Parser (recursive descent) ─────────────────────────
function parse(tokens, host) {
    let pos = 0;
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
    function primary() {
        const tk = peek();
        if (tk.t === TOKEN.NUMBER) { pos++; return { kind: 'num', v: tk.v }; }
        if (tk.t === TOKEN.STRING) { pos++; return { kind: 'str', v: tk.v }; }
        if (tk.t === TOKEN.BOOL) { pos++; return { kind: 'bool', v: tk.v }; }
        if (tk.t === TOKEN.NULL) { pos++; return { kind: 'null' }; }
        if (tk.t === TOKEN.LPAREN) { pos++; const e = ternary(); eat(TOKEN.RPAREN); return e; }
        if (tk.t === TOKEN.IDENT) {
            pos++;
            if (peek().t === TOKEN.LPAREN) {
                // FUNCTIONS wins a name clash, so a host can never change
                // what a whitelisted function means.
                const spec = !hasOwn(FUNCTIONS, tk.v) && hasOwn(host, tk.v) ? host[tk.v] : null;
                if (!spec && !hasOwn(FUNCTIONS, tk.v)) {
                    throw new ExprError(`Unknown function: ${tk.v}`, tk.i);
                }
                eat(TOKEN.LPAREN);
                const args = [];
                if (peek().t !== TOKEN.RPAREN) {
                    args.push(ternary());
                    while (accept(TOKEN.COMMA)) args.push(ternary());
                }
                eat(TOKEN.RPAREN);
                if (!spec) return { kind: 'call', name: tk.v, args };
                // A host call inside another host call's arguments would need
                // its own answer before the caller could collect what to ask.
                if (args.some((a) => collectHostCalls(a).length > 0)) {
                    throw new ExprError(`${tk.v}() cannot be used inside another ${tk.v}()`, tk.i);
                }
                const problem = typeof spec.check === 'function' ? spec.check(args) : null;
                if (problem) throw new ExprError(problem, tk.i);
                return { kind: 'hostcall', name: tk.v, args };
            }
            const path = [{ kind: 'name', v: tk.v }];
            while (true) {
                if (accept(TOKEN.DOT)) {
                    const id = eat(TOKEN.IDENT);
                    path.push({ kind: 'name', v: id.v });
                } else if (accept(TOKEN.LBRACK)) {
                    // `[*]` wildcard — same flatten-map semantics as the
                    // binding resolver's walkPath, so a picker-inserted path
                    // like `steps.x.output.results[*].subject` evaluates to
                    // the array of subjects instead of throwing
                    // "Unexpected token: *" (which conditions swallowed into a
                    // silent `false` → wrong branch).
                    if (peek().t === TOKEN.STAR) {
                        eat(TOKEN.STAR);
                        eat(TOKEN.RBRACK);
                        path.push({ kind: 'wildcard' });
                    } else if ((peek().t === TOKEN.IDENT || peek().t === TOKEN.STRING) && tokens[pos + 1]?.t === TOKEN.ASSIGN) {
                        // `[key="value"]` — the first element whose key equals
                        // the literal (path.mjs stepMatch), so a picked
                        // `headers[name="Subject"].value` reads the same here.
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
                        path.push({ kind: 'match', key, value });
                    } else if (peek().t === TOKEN.NUMBER && /^[0-9]+$/.test(peek().raw || '') && !Number.isSafeInteger(peek().v) && tokens[pos + 1]?.t === TOKEN.RBRACK) {
                        // A digit key past 2^53 (a snowflake id) would round as
                        // a number; read it as the key it spells, as path.mjs does.
                        const key = tokens[pos++].raw;
                        eat(TOKEN.RBRACK);
                        path.push({ kind: 'index', expr: { kind: 'str', v: key } });
                    } else {
                        const idx = ternary();
                        eat(TOKEN.RBRACK);
                        path.push({ kind: 'index', expr: idx });
                    }
                } else break;
            }
            return { kind: 'path', segments: path };
        }
        throw new ExprError(`Unexpected token: ${tk.t}`, tk.i);
    }

    const ast = ternary();
    if (peek().t !== TOKEN.EOF) throw new ExprError('Trailing tokens in expression', peek().i);
    return ast;
}

// ── Evaluator ──────────────────────────────────────────
function walkPath(segments, runState, host) {
    let cur = runState;
    const cache = jsonCacheFor(runState);
    for (let i = 0; i < segments.length; i++) {
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
                else tokens.push({ type: 'prop', key: evalNode(r.expr, runState, host) });
            }
            return walkTokens([{ type: 'wild' }, ...tokens], cur);
        } else if (s.kind === 'match') {
            cur = stepMatch(cur, s.key, s.value, cache);
        } else if (s.kind === 'root') {
            // Internal marker kept for callers that seed a walk at a value.
            cur = s.v;
        } else {
            const k = evalNode(s.expr, runState, host);
            if (cur == null) return undefined;
            // Same gate as the dot branch: x["constructor"] stays undefined,
            // `name[0]` on a string works exactly as it does in a ref binding.
            if (typeof k !== 'string' && typeof k !== 'number') return undefined;
            cur = stepInto(cur, k, cache);
        }
    }
    return cur;
}

function evalNode(n, ctx, host) {
    switch (n.kind) {
        case 'num': return n.v;
        case 'str': return n.v;
        case 'bool': return n.v;
        case 'null': return null;
        case 'path': return walkPath(n.segments, ctx, host);
        case 'call': {
            const fn = FUNCTIONS[n.name];
            if (!fn) throw new ExprError(`Unknown function: ${n.name}`);
            return fn(...n.args.map((a) => evalNode(a, ctx, host)));
        }
        case 'hostcall': {
            const h = hasOwn(host, n.name) ? host[n.name] : null;
            if (!h || typeof h.fn !== 'function') {
                throw new ExprError(h?.unanswered || `${n.name}() has no answer here`);
            }
            return h.fn(...n.args.map((a) => evalNode(a, ctx, host)));
        }
        case 'unop': {
            const v = evalNode(n.a, ctx, host);
            if (n.op === '!') return !v;
            if (n.op === '-') return -v;
            if (n.op === '+') return +v;
            return undefined;
        }
        case 'binop': {
            if (n.op === '&&') return evalNode(n.a, ctx, host) && evalNode(n.b, ctx, host);
            if (n.op === '||') return evalNode(n.a, ctx, host) || evalNode(n.b, ctx, host);
            const a = evalNode(n.a, ctx, host);
            const b = evalNode(n.b, ctx, host);
            switch (n.op) {
                case '+': return a + b;
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
        case 'ternary': return evalNode(n.cond, ctx, host) ? evalNode(n.a, ctx, host) : evalNode(n.b, ctx, host);
        default: throw new ExprError(`Unknown node kind: ${n.kind}`);
    }
}

// Distinct root identifiers referenced by a path (for validation without
// executing) — e.g. `actions.x.result + form.total` → ['actions','form'].
function collectRefs(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (node.kind === 'path' && node.segments[0]?.kind === 'name') out.add(node.segments[0].v);
    for (const key of ['a', 'b', 'cond', 'expr']) if (node[key]) collectRefs(node[key], out);
    if (node.segments) for (const s of node.segments) if (s.expr) collectRefs(s.expr, out);
    if (node.args) for (const a of node.args) collectRefs(a, out);
    return out;
}

/**
 * Every host call in an AST, in source order: the nodes a caller has to
 * answer before it evaluates. Walks the same keys as collectRefs.
 */
export function collectHostCalls(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.kind === 'hostcall') out.push(node);
    // `cond` first: a ternary's condition comes before its branches.
    for (const key of ['cond', 'a', 'b', 'expr']) if (node[key]) collectHostCalls(node[key], out);
    if (node.segments) for (const s of node.segments) if (s.expr) collectHostCalls(s.expr, out);
    if (node.args) for (const a of node.args) collectHostCalls(a, out);
    return out;
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
    return evalNode(ast, scope || {}, opts?.host || null);
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

export { FUNCTIONS, EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES };
