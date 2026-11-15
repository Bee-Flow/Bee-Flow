/**
 * Windmill `input_transforms` JavaScript to Bee Flow bindings (PLAN B3 mapExpr.mts).
 *
 * The expression is PARSED with acorn, never evaluated, and the syntax tree is
 * translated into the restricted Bee Flow expression language
 * (server/shared/expr/engine.mjs). Whatever has no exact counterpart is
 * refused with a reason, so the caller turns it into an AI checklist item
 * with the original text; nothing is guessed.
 *
 *   translateInput(input, scope)  -> a binding ({kind: literal|ref|template|expr}), a dropped input,
 *                                    a connection to set up, or an AI item
 *   translateRule(expr, scope)    -> a DSL rule string (branches, skip_if, stop_after_if), or an AI item
 *
 * The names a Windmill expression can see are resolved by the `ExprScope`
 * the module mapper hands in: `flow_input.*` (the trigger payload, re-mapped
 * to the Bee Flow trigger), `results.<id>.*` (an earlier step, re-mapped via
 * the output shape of what it became), `flow_input.iter.value/index` (the
 * loop item), `resume` (an approval's decision), `result` (the step itself, in
 * stop_after_if) and `previous_result` (the step before, older flows).
 *
 * Translated: paths, `?.` (dropped: a missing member already reads as
 * nothing), literals, template literals and `+` concatenation, `! - +`,
 * comparisons, `&& || ??`, the ternary, list literals, `.length`,
 * `.filter/.map/.some/.every(x => …)` (the parameter becomes `it`; a nested
 * arrow is refused, there is only one `it`), `.find(x => x.k === v)`
 * (`find(list, "k", v)`, any other predicate `filter(list, …)[0]`),
 * `s.split(d)[s.split(d).length - 1]` (`last(split(s, d))`), `.split .join
 * .trim .toLowerCase .toUpperCase .replaceAll .toString`,
 * `String() Number() Math.*() Object.keys/values()`.
 *
 * Refused: an object literal (an automation expression has none; a set step
 * builds an object), a name the scope does not know, a computed key that is not a
 * literal, `constructor` / `__proto__` / `prototype` anywhere, regular
 * expressions, `new`, `typeof`, assignments, `JSON.stringify` (text of an
 * object has no exact counterpart) and every other call.
 */

import * as acorn from 'acorn';
import type { WmInput } from './ir.mts';
import type { Binding, Ctx, ExprScope, Node } from './exprTypes.mts';
import { Dropped, MAX_SOURCE, Unsupported } from './exprTypes.mts';
import { emit } from './exprEmit.mts';
import { refsInValue } from './refs.mts';
import { scrubValue } from './scrub.mts';

import { parseExpr } from '../../../shared/expr/index.mjs';

export type { Binding, ExprScope, Resolved, Seg } from './exprTypes.mts';
export { segText } from './exprTypes.mts';

export type InputResult =
    | { kind: 'binding'; binding: Binding; confidence: 'high' | 'medium'; secretsRemoved?: number }
    | { kind: 'drop'; reason: string }
    | { kind: 'connection'; refs: Array<{ kind: 'resource' | 'variable'; path: string }> }
    | { kind: 'ai'; reason: string; original: string };

export type RuleResult = { kind: 'rule'; expr: string; confidence: 'high' | 'medium' } | { kind: 'ai'; reason: string; original: string };

function newCtx(scope: ExprScope, src: string): Ctx {
    return { scope, src, it: null, medium: false, emit };
}

export function translateInput(input: WmInput, scope: ExprScope): InputResult {
    if (input.type === 'ai') return { kind: 'ai', reason: 'Windmill lets an AI choose this value at run time.', original: '(ai)' };
    if (input.type === 'static') return translateStatic(input.value);
    const src = input.expr.trim();
    if (!src) return { kind: 'binding', binding: { kind: 'literal', value: null }, confidence: 'high' };
    try {
        const ctx = newCtx(scope, src);
        const node = parseWhole(src);
        const binding = bindingOf(node, ctx);
        return { kind: 'binding', binding, confidence: ctx.medium ? 'medium' : 'high' };
    } catch (e) {
        if (e instanceof Dropped) return { kind: 'drop', reason: e.message };
        return { kind: 'ai', reason: reasonOf(e), original: src };
    }
}

/** Translate a condition (a branch, skip_if, stop_after_if) into a DSL rule. */
export function translateRule(expr: string, scope: ExprScope): RuleResult {
    const src = expr.trim();
    try {
        const ctx = newCtx(scope, src);
        const out = emit(parseWhole(src), ctx);
        checkDsl(out.dsl);
        return { kind: 'rule', expr: out.dsl, confidence: ctx.medium ? 'medium' : 'high' };
    } catch (e) {
        return { kind: 'ai', reason: reasonOf(e), original: src };
    }
}

function reasonOf(e: unknown): string {
    if (e instanceof Unsupported || e instanceof Dropped) return e.message;
    return `It does not parse as an expression (${e instanceof Error ? e.message : String(e)}).`;
}

function translateStatic(value: unknown): InputResult {
    const refs = refsInValue(value);
    if (refs.length) return { kind: 'connection', refs };
    const counter = { removed: 0 };
    const clean = scrubValue(value, counter);
    return {
        kind: 'binding',
        binding: { kind: 'literal', value: clean },
        confidence: 'high',
        ...(counter.removed ? { secretsRemoved: counter.removed } : {}),
    };
}

function parseWhole(src: string): Node {
    if (src.length > MAX_SOURCE) throw new Unsupported('The expression is too long to translate.');
    const node = acorn.parseExpressionAt(src, 0, { ecmaVersion: 'latest', preserveParens: true }) as Node;
    let end = node.end;
    while (end < src.length && (src[end] === ' ' || src[end] === '\n' || src[end] === '\t' || src[end] === ';' || src[end] === '\r')) end += 1;
    if (end !== src.length) throw new Unsupported('The expression has more than one statement.');
    return node;
}

function checkDsl(dsl: string): void {
    // An automation expression has no object literals (core/automationModel/refPaths.js tryParseExpr).
    try { parseExpr(dsl, { objects: false }); }
    catch (e) { throw new Unsupported(`The translation is not a valid Bee Flow expression (${e instanceof Error ? e.message : String(e)}).`); }
}

function bindingOf(node: Node, ctx: Ctx): Binding {
    const template = templateOf(node, ctx);
    if (template !== null) return { kind: 'template', value: template };
    const out = emit(node, ctx);
    if (out.text !== undefined) return { kind: 'literal', value: out.text };
    if (out.path) return { kind: 'ref', path: out.path };
    const literal = literalValue(node);
    if (literal.ok) return { kind: 'literal', value: literal.value };
    checkDsl(out.dsl);
    return { kind: 'expr', value: out.dsl };
}

/** A literal number / boolean / null / list / object of literals, as a value. */
function literalValue(node: Node): { ok: boolean; value?: unknown } {
    if (node.type === 'Literal' && !(node as Record<string, unknown>).regex) return { ok: true, value: node.value };
    return { ok: false };
}

// ── Templates ────────────────────────────────────────────────────────────

/** `…${path}…` or `"a" + path + "b"` where every hole is a plain path: a template string. */
function templateOf(node: Node, ctx: Ctx): string | null {
    const parts = templateParts(node);
    if (!parts) return null;
    if (!parts.some((p) => typeof p === 'string')) return null;
    let out = '';
    for (const part of parts) {
        if (typeof part === 'string') {
            if (part.includes('{{') || part.includes('}}')) return null;
            out += part;
            continue;
        }
        const piece = emit(part, ctx);
        if (piece.text !== undefined) { out += piece.text; continue; }
        if (!piece.path) return null;
        out += `{{${piece.path}}}`;
    }
    return out;
}

function templateParts(node: Node): Array<string | Node> | null {
    if (node.type === 'ParenthesizedExpression') return templateParts(node.expression as Node);
    if (node.type === 'TemplateLiteral') {
        const quasis = node.quasis as Array<{ value: { cooked: string | null } }>;
        const exprs = node.expressions as Node[];
        const parts: Array<string | Node> = [];
        quasis.forEach((q, i) => {
            if (q.value.cooked) parts.push(q.value.cooked);
            if (exprs[i]) parts.push(exprs[i]);
        });
        return parts.some((p) => typeof p === 'string') || exprs.length === 0 ? parts : null;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
        const flat = flattenPlus(node);
        const hasText = flat.some((n) => (n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral');
        if (!hasText) return null;
        const parts: Array<string | Node> = [];
        for (const n of flat) {
            if (n.type === 'Literal' && typeof n.value === 'string') parts.push(n.value);
            else if (n.type === 'TemplateLiteral') { const inner = templateParts(n); if (!inner) return null; parts.push(...inner); }
            else parts.push(n);
        }
        return parts;
    }
    return null;
}

function flattenPlus(node: Node): Node[] {
    if (node.type === 'BinaryExpression' && node.operator === '+') {
        return [...flattenPlus(node.left as Node), ...flattenPlus(node.right as Node)];
    }
    if (node.type === 'ParenthesizedExpression') return flattenPlus(node.expression as Node);
    return [node];
}

