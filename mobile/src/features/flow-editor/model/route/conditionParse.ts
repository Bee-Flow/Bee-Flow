/**
 * An expression back into clickable rows — the parsing half of the web
 * builder's utils/conditionModel.js, pinned by route.lockstep.test.ts.
 *
 * Anything it cannot recognise (mixed `&&`/`||`, function composition,
 * arithmetic on the left) returns null, and the editor keeps the raw
 * expression field instead. The parser stays strict on purpose.
 */

import { canonicalRefPath } from '../pathGrammar';
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
    return isCleanPath(t) ? { kind: 'ref', path: canonicalRefPath(t) } : null;
}

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

// `[!]name(arg, …)` as a whole fragment: the arguments split on top-level
// commas only, outside strings, brackets and parens, so a field like
// `headers[name="a,b"]` or a text like "a, b" stays one argument. (The web
// also reads `isAbout(…)`; the phone has no topic operators, so it stays raw.)
const CALL_HEAD_RE = /^(!\s*)?(isEmpty|isAbout|contains|startsWith|endsWith)\(/;

/** The arguments from `from` up to the call's own `)` (`{ args, end }`), or null when unclosed. */
function splitArgs(text: string, start: number): { args: string[]; end: number } | null {
    const args: string[] = [];
    let from = start;
    let depth = 0;
    let str: string | null = null;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (str) {
            if (c === '\\') i++;
            else if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'") str = c;
        else if (c === '(' || c === '[') depth++;
        else if (depth > 0 && (c === ')' || c === ']')) depth--;
        else if (depth === 0 && c === ',') {
            args.push(text.slice(from, i).trim());
            from = i + 1;
        } else if (c === ')') return { args: [...args, text.slice(from, i).trim()], end: i };
    }
    return null;
}

/** The helper-call shapes: isEmpty, !isEmpty, !contains, contains/startsWith/endsWith. */
function parseCall(text: string): ConditionRow | null | undefined {
    const head = CALL_HEAD_RE.exec(text);
    if (!head) return undefined;
    const inner = splitArgs(text, head[0].length);
    // The call's own `)` must end the fragment (`contains(a, b) + 1` is a formula).
    if (!inner || inner.end !== text.length - 1) return undefined;
    const negate = !!head[1];
    const fn = head[2] as string;
    const { args } = inner;
    if (fn === 'isEmpty') return args.length === 1 ? row(fieldFromLeft(args[0]), negate ? 'isNotEmpty' : 'isEmpty') : null;
    if (fn === 'isAbout' || args.length !== 2 || !args[1] || (negate && fn !== 'contains')) return null;
    return row(fieldFromLeft(args[0]), negate ? 'notContains' : fn, valueRawToBinding(args[1]));
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
    if (!/^(true|false|null)$/.test(text) && isCleanPath(text)) return row({ kind: 'ref', path: canonicalRefPath(text) }, 'truthy');
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
