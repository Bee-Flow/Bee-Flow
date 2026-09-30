/**
 * An expression back into clickable rows — the parsing half of the web
 * builder's utils/conditionModel.js, pinned by route.lockstep.test.ts.
 *
 * Anything it cannot recognise (mixed `&&`/`||`, function composition,
 * arithmetic on the left) returns null, and the editor keeps the raw
 * expression field instead. The parser stays strict on purpose.
 */

import type { Binding } from '../types';
import { bindingFromInput, isCleanPath } from './bindingText';
import type { ConditionRow, ConditionRows } from './conditionModel';

type Join = '&&' | '||';

interface ScanState {
    parts: string[];
    buf: string;
    depth: number;
    str: string | null;
    join: Join | null;
}

/** Feed one character of a quoted string; returns how many extra chars were consumed. */
function scanString(s: ScanState, expr: string, i: number): number {
    const c = expr[i] as string;
    s.buf += c;
    if (c === '\\' && i + 1 < expr.length) {
        s.buf += expr[i + 1];
        return 1;
    }
    if (c === s.str) s.str = null;
    return 0;
}

/**
 * Split on top-level `&&` or `||` (outside strings and brackets). Null when
 * BOTH appear at top level, or the brackets/quotes do not balance.
 */
/** Track quotes and bracket depth for one character outside a string. */
function scanStructure(s: ScanState, c: string): void {
    if (c === '"' || c === "'") s.str = c;
    else if (c === '(' || c === '[') s.depth++;
    else if (c === ')' || c === ']') s.depth--;
}

/** A top-level joiner at `i`, or null. */
function joinerAt(s: ScanState, expr: string, i: number): Join | null {
    const two = expr.slice(i, i + 2);
    return !s.str && s.depth === 0 && (two === '&&' || two === '||') ? two : null;
}

function splitTopLevel(expr: string): { parts: string[]; join: Join } | null {
    const s: ScanState = { parts: [], buf: '', depth: 0, str: null, join: null };
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i] as string;
        if (s.str) {
            i += scanString(s, expr, i);
            continue;
        }
        scanStructure(s, c);
        const join = joinerAt(s, expr, i);
        if (!join) {
            s.buf += c;
            continue;
        }
        if (s.join && s.join !== join) return null;
        s.join = join;
        s.parts.push(s.buf.trim());
        s.buf = '';
        i++;
    }
    if (s.str || s.depth !== 0) return null;
    s.parts.push(s.buf.trim());
    return { parts: s.parts.filter((p) => p.length), join: s.join || '&&' };
}

const SYMBOL_TO_KEY: Record<string, string> = {
    '==': 'eq', '!=': 'neq', '===': 'seq', '!==': 'sneq', '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt',
};

/** A raw right-hand side (`"file"`, `1000`, `steps.x.y`) as a binding. */
function valueRawToBinding(rawText: unknown): Binding {
    const trimmed = String(rawText ?? '').trim();
    if (/^(true|false|null)$/.test(trimmed)) {
        return { kind: 'literal', value: trimmed === 'null' ? null : trimmed === 'true' };
    }
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

/** Only a clean path is a parsed field; a `[*]` wildcard is not comparable to a scalar. */
function fieldFromLeft(left: unknown): Binding | null {
    const t = String(left || '').trim();
    if (t.includes('[*]')) return null;
    return isCleanPath(t) ? { kind: 'ref', path: t } : null;
}

const FN_RE = /^(contains|startsWith|endsWith)\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/;
const CMP_SYMBOLS = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];
const OP_CHARS = new Set(['=', '!', '<', '>']);

function findTopLevelSymbol(text: string, sym: string): number {
    let depth = 0;
    let str: string | null = null;
    for (let i = 0; i <= text.length - sym.length; i++) {
        const c = text[i];
        if (str) {
            if (c === '\\') i++;
            else if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'") str = c;
        else if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (depth === 0 && text.slice(i, i + sym.length) === sym) return i;
    }
    return -1;
}

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

const row = (field: Binding | null, op: string, value: Binding = { kind: 'literal', value: '' }): ConditionRow | null =>
    field && { field, op, value };

/** The helper-call shapes: isEmpty, !isEmpty, !contains, contains/startsWith/endsWith. */
function parseCall(text: string): ConditionRow | null | undefined {
    let m = /^!\s*isEmpty\(\s*(.+?)\s*\)$/.exec(text);
    if (m) return row(fieldFromLeft(m[1]), 'isNotEmpty');
    m = /^isEmpty\(\s*(.+?)\s*\)$/.exec(text);
    if (m) return row(fieldFromLeft(m[1]), 'isEmpty');
    m = /^!\s*contains\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/.exec(text);
    if (m) return row(fieldFromLeft(m[1]), 'notContains', valueRawToBinding(m[2]));
    m = FN_RE.exec(text);
    if (m) return row(fieldFromLeft(m[2]), m[1] as string, valueRawToBinding(m[3]));
    return undefined;
}

/** One fragment as a row, or null when it is not a recognised shape. */
function parseFragment(part: string): ConditionRow | null {
    const text = part.trim();
    if (!text) return null;
    const call = parseCall(text);
    if (call !== undefined) return call;
    const cmp = parseComparator(text);
    if (cmp) {
        const f = fieldFromLeft(cmp.left);
        if (!f) return null;
        if (cmp.op === 'eq' && /^(true|false)$/.test(cmp.right)) return row(f, cmp.right === 'true' ? 'isTrue' : 'isFalse');
        return row(f, cmp.op, valueRawToBinding(cmp.right));
    }
    // A bare field (a truthiness check); `[*]` IS allowed here.
    if (!/^(true|false|null)$/.test(text) && isCleanPath(text)) return row({ kind: 'ref', path: text }, 'truthy');
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
