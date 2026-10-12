/**
 * An expression back into clickable rows — the parsing half of the web
 * builder's utils/conditionModel.js, pinned by route.lockstep.test.ts.
 *
 * The scanners (top-level `&&`/`||`, call arguments, comparator symbols) and
 * the rule shapes (`anyOf(item.attachments[*].mimeType, "contains", "pdf")`,
 * `fileType(item)`) are the shared ones (@/shared/expr rules.mjs), so the
 * phone, the browser and the server read a rule the same way.
 *
 * Anything it cannot recognise (mixed `&&`/`||`, function composition,
 * arithmetic on the left) returns null, and the editor shows the rule as a
 * formula instead. Reading never rewrites: a saved `x == "Open"` comes back
 * as the "is exactly" row that writes `==` again.
 */

import { fieldShape, findTopLevelSymbol, readQuantifiedCall, splitCallArgs, splitTopLevel } from '@/shared/expr';

import { canonicalRefPath } from '../pathGrammar';
import type { Binding } from '../types';
import { bindingFromInput, isCleanPath } from './bindingText';
import { isBlankValue, isUnaryOp, type ConditionRow, type ConditionRows, type Quantifier } from './conditionModel';

const SYMBOL_TO_KEY: Record<string, string> = {
    '==': 'eq', '!=': 'neq', '===': 'seq', '!==': 'sneq', '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt',
};

const BLANK: Binding = { kind: 'literal', value: '' };

/** A raw right-hand side (`"file"`, `1000`, `steps.x.y`) as a binding. */
function valueRawToBinding(rawText: unknown): Binding {
    const trimmed = String(rawText ?? '').trim();
    if (trimmed === 'true' || trimmed === 'false') return { kind: 'literal', value: trimmed === 'true' };
    if (trimmed === 'null') return { kind: 'literal', value: null };
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { kind: 'literal', value: Number(trimmed) };
    const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
    if (quoted) {
        try {
            return { kind: 'literal', value: JSON.parse(trimmed.replace(/'/g, '"')) };
        } catch {
            return { kind: 'literal', value: trimmed.slice(1, -1) };
        }
    }
    return bindingFromInput(trimmed, 'expression');
}

/**
 * A field the rows can hold: a clean path (no `[*]` — a whole list is not
 * comparable to one value), or the File type of the item (`fileType(item)`).
 */
function fieldFromLeft(left: unknown): Binding | null {
    const t = String(left || '').trim();
    if (fieldShape(t)?.kind === 'fileRecord') return { kind: 'ref', path: (fieldShape(t) as { path: string }).path };
    if (t.includes('[*]')) return null;
    return isCleanPath(t) ? { kind: 'ref', path: canonicalRefPath(t) } : null;
}

/** A list column (`item.attachments[*].mimeType`) or the File type of a list, as a quantified row's field. */
function quantifiedField(left: unknown): Binding | null {
    const shape = fieldShape(String(left || '').trim());
    return shape && (shape.kind === 'column' || shape.kind === 'fileList') ? { kind: 'ref', path: shape.path } : null;
}

/** A row; a saved blank value (`x == ""`) is marked so it keeps round-tripping. */
function row(field: Binding | null, op: string, value: Binding = BLANK, quantifier?: Quantifier): ConditionRow | null {
    if (!field) return null;
    const out: ConditionRow = { field, op, value };
    if (quantifier) out.quantifier = quantifier;
    if (!isUnaryOp(op) && isBlankValue(value)) out.keepBlank = true;
    return out;
}

const OP_CHARS = new Set(['=', '!', '<', '>']);
const CMP_SYMBOLS = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];

function parseComparator(text: string): { left: string; op: string; right: string } | null {
    for (const sym of CMP_SYMBOLS) {
        const idx = findTopLevelSymbol(text, sym);
        if (idx === -1) continue;
        const before = idx > 0 ? (text[idx - 1] as string) : ' ';
        const after = idx + sym.length < text.length ? (text[idx + sym.length] as string) : ' ';
        if (OP_CHARS.has(before) || OP_CHARS.has(after)) continue;
        const left = text.slice(0, idx).trim();
        const right = text.slice(idx + sym.length).trim();
        if (!left || !right) return null;
        return { left, op: SYMBOL_TO_KEY[sym] as string, right };
    }
    return null;
}

// `[!]name(arg, …)` as a whole fragment. (The web also reads `isAbout(…)`; the
// phone has no topic operators, so such a rule stays a formula here.)
const CALL_HEAD_RE = /^(!\s*)?(isEmpty|isAbout|contains|startsWith|endsWith|equals)\(/;

/** A legacy `[!]contains(<column>, v)`: any (or no) entry of the column contains v. */
function legacyColumnContains(args: string[], negate: boolean): ConditionRow | null {
    const field = args.length === 2 && args[1] ? quantifiedField(args[0]) : null;
    if (!field || fieldShape(String(args[0]).trim())?.kind !== 'column') return null;
    return row(field, 'contains', valueRawToBinding(args[1]), negate ? 'none' : 'any');
}

/** A row for a recognised helper call, or null. */
function rowFromCall(fn: string, negate: boolean, args: string[]): ConditionRow | null {
    if (fn === 'isAbout') return null;
    const f = fieldFromLeft(args[0]);
    if (fn === 'isEmpty') return args.length === 1 ? row(f, negate ? 'isNotEmpty' : 'isEmpty') : null;
    if (args.length !== 2 || !args[1]) return null;
    if (fn === 'equals') return row(f, negate ? 'isNot' : 'is', valueRawToBinding(args[1]));
    if (fn === 'contains' && !f) return legacyColumnContains(args, negate);
    if (negate && fn !== 'contains') return null;
    return row(f, negate ? 'notContains' : fn, valueRawToBinding(args[1]));
}

/** The helper-call shapes; undefined when the fragment is not one call. */
function parseCall(text: string): ConditionRow | null | undefined {
    const head = CALL_HEAD_RE.exec(text);
    if (!head) return undefined;
    const inner = splitCallArgs(text, head[0].length);
    // The call's own `)` must end the fragment (`contains(a, b) + 1` is a formula).
    if (!inner || inner.end !== text.length - 1) return undefined;
    return rowFromCall(head[2] as string, !!head[1], inner.args);
}

/** `anyOf / everyOf / noneOf(<column>, "<test>"[, value])` as a quantified row. */
function parseQuantified(text: string): ConditionRow | null | undefined {
    const q = readQuantifiedCall(text);
    if (!q) return undefined;
    const value = q.rhs == null ? BLANK : valueRawToBinding(q.rhs);
    return row(quantifiedField(q.left), q.op, value, q.quantifier as Quantifier);
}

/** One fragment as a row, or null when it is not a recognised shape. */
function parseFragment(part: string): ConditionRow | null {
    const text = part.trim();
    if (!text) return null;
    const quantified = parseQuantified(text);
    if (quantified !== undefined) return quantified;
    const call = parseCall(text);
    if (call !== undefined) return call;
    const cmp = parseComparator(text);
    if (cmp) {
        const f = fieldFromLeft(cmp.left);
        if (!f) return null;
        if (cmp.op === 'eq' && (cmp.right === 'true' || cmp.right === 'false')) return row(f, cmp.right === 'true' ? 'isTrue' : 'isFalse');
        return row(f, cmp.op, valueRawToBinding(cmp.right));
    }
    // A bare field (a truthiness check); `[*]` IS allowed here.
    if (text !== 'true' && text !== 'false' && text !== 'null' && isCleanPath(text)) return row({ kind: 'ref', path: canonicalRefPath(text) }, 'truthy');
    return null;
}

/** `{ rows, join }` for the clickable builder, or null when the expression does not fit. */
export function parseExprToRows(expr: unknown): ConditionRows | null {
    if (typeof expr !== 'string' || !expr.trim()) return null;
    const split = splitTopLevel(expr.trim());
    if (!split) return null;
    const rows: ConditionRow[] = [];
    for (const part of split.parts) {
        const parsed = parseFragment(part);
        if (!parsed) return null;
        rows.push(parsed);
    }
    return rows.length ? { rows, join: split.join } : null;
}
