/**
 * The condition-builder half of agent-hub `utils/bindingHelpers.js`: split a
 * simple `<path> <op> <value>` expression into slots, and serialise slots and
 * bindings back into the restricted expression grammar. Pinned by
 * bindingHelpers.lockstep.test.ts.
 */

import type { BindingValue } from './types';
import { isCleanPath, renderBindingValue } from '../model/route/bindingText';

// A binding as an expression's right-hand side: the Condition node's model owns it.
export { renderBindingValue };

// Longest first, so `>=` is never read as `>`.
const COND_OPS = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];
const OP_CHARS = new Set(['=', '!', '<', '>']);

function findOperator(text: string, op: string): number {
    let from = 0;
    while (from < text.length) {
        const idx = text.indexOf(op, from);
        if (idx === -1) return -1;
        const before = idx > 0 ? text.charAt(idx - 1) : ' ';
        const after = idx + op.length < text.length ? text.charAt(idx + op.length) : ' ';
        // Surrounded by other operator characters: part of a longer operator.
        if (OP_CHARS.has(before) || OP_CHARS.has(after)) {
            from = idx + 1;
            continue;
        }
        return idx;
    }
    return -1;
}

/**
 * `steps.s1.output.total > 1000` → `{ leftPath, op, rightRaw }`, or null when
 * the expression is not that simple shape (the builder then shows raw text).
 */
export function parseSimpleCondition(expr: unknown): { leftPath: string; op: string; rightRaw: string } | null {
    if (typeof expr !== 'string') return null;
    const text = expr.trim();
    if (!text) return null;
    for (const op of COND_OPS) {
        const idx = findOperator(text, op);
        if (idx === -1) continue;
        const left = text.slice(0, idx).trim();
        const right = text.slice(idx + op.length).trim();
        if (!left || !right) continue;
        if (!isCleanPath(left)) return null;
        return { leftPath: left, op, rightRaw: right };
    }
    return null;
}

/** The three slots of the visual condition builder, as one expression. */
export function buildConditionExpr(leftPath: unknown, op: string, rightBinding: BindingValue): string {
    const left = String(leftPath || '').trim();
    if (!left) return '';
    return `${left} ${op} ${renderBindingValue(rightBinding)}`;
}
