/**
 * Tokenize a bound-field value into literal text and step/trigger/loop
 * REFERENCE tokens, so a field can show `steps.ai_87e358.output.x` as a chip
 * with the step's NAME. Display-only: `serializeRefTokens(parseRefTokens(x))`
 * is `x` for any input. Port of agent-hub `Builder/mapping/refTokens.js`;
 * pinned by refTokens.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';
import { formatPath, readPath, scanTemplate, type PathToken } from '@/shared/expr';

import { detectTemplate, isCleanPath, refPathTokens } from './walkPath';
import { humanizeFieldTail } from '../model/displayHelpers';

// The roots a pill can name.
const REF_ROOTS = ['steps', 'trigger', 'loop'];

export interface RefInfo {
    source: 'steps' | 'trigger' | 'loop';
    stepId?: string;
    itemVar?: string;
    fieldPath: string;
}

export type RefToken =
    | { type: 'literal'; text: string }
    | ({ type: 'ref'; raw: string; path: string; wrapped: boolean } & RefInfo);

const tailOf = (tokens: PathToken[]) => (tokens.length ? formatPath(tokens) : '');
const named = (tok: PathToken | undefined): tok is { type: 'prop'; key: string } => tok?.type === 'prop' && typeof tok.key === 'string';

/**
 * A bare path as a ref — or null. WHAT counts as one reference is the
 * runtime's path grammar: a bracket right after `output`, a quoted key holding
 * `}` or `]`, a match segment (`headers[name="Subject"].value`).
 */
export function classifyRef(path: unknown): RefInfo | null {
    if (typeof path !== 'string') return null;
    const tokens = refPathTokens(path);
    if (!tokens) return null;
    const [head, second, third] = tokens;
    const headKey = (head as { key?: unknown }).key;
    if (headKey === 'steps') {
        if (named(second) && named(third) && third.key === 'output') {
            return { source: 'steps', stepId: second.key, fieldPath: tailOf(tokens.slice(3)) };
        }
        return null;
    }
    if (headKey === 'loop') return named(second) ? { source: 'loop', itemVar: second.key, fieldPath: tailOf(tokens.slice(2)) } : null;
    if (headKey === 'trigger') {
        const rest = named(second) && second.key === 'output' ? tokens.slice(2) : tokens.slice(1);
        return { source: 'trigger', fieldPath: tailOf(rest) };
    }
    return null;
}

/**
 * The name a pill shows after its source — model/displayHelpers
 * humanizeFieldTail, so every label reads a path the way its pill does.
 */
export function fieldTailLabel(fieldPath: unknown): string {
    return humanizeFieldTail(fieldPath);
}

function tokenizeTemplate(s: string): RefToken[] {
    return scanTemplate(s).map((p): RefToken => {
        if (p.type === 'text') return { type: 'literal', text: p.value };
        const ref = classifyRef(p.inner);
        return ref ? { type: 'ref', raw: p.raw, path: p.inner, wrapped: true, ...ref } : { type: 'literal', text: p.raw };
    });
}

function tokenizeExpression(s: string): RefToken[] {
    const trimmed = s.trim();
    if (isCleanPath(trimmed)) {
        const ref = classifyRef(trimmed);
        if (ref) {
            const lead = s.slice(0, s.length - s.trimStart().length);
            const trail = s.slice(s.trimEnd().length);
            return [
                ...(lead ? [{ type: 'literal' as const, text: lead }] : []),
                { type: 'ref', raw: trimmed, path: trimmed, wrapped: false, ...ref },
                ...(trail ? [{ type: 'literal' as const, text: trail }] : []),
            ];
        }
    }
    const tokens: RefToken[] = [];
    for (const part of scanExprPaths(s, REF_ROOTS)) {
        const text = 'path' in part ? part.path : part.text;
        const ref = 'path' in part ? classifyRef(part.path) : null;
        const prev = tokens[tokens.length - 1];
        if (ref) tokens.push({ type: 'ref', raw: text, path: text, wrapped: false, ...ref });
        else if (prev?.type === 'literal') prev.text += text;
        else tokens.push({ type: 'literal', text });
    }
    return tokens;
}

// ── The expression engine's path grammar, for scanning formulas ─────────
// What the ENGINE reads as one path (engine.mjs tokenize): the shared path
// grammar (readPath: brackets, digits and accents after a dot) minus `-`
// (a minus) and `@`. A computed index (`[i]`) ends the path; a whole stored
// ref keeps its dashed key (tokenizeExpression asks isCleanPath first).
const IDENT_START = /[\p{L}_$]/u;
const IDENT_CHAR = /[\p{L}\p{N}\p{M}_$]/u;
const GLUED = /[\p{L}\p{N}\p{M}_$.]/u;
const INLINE_HEAD = /steps\.[A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)+\.output/y;
const MARK = /\p{M}/u;

function identEnd(s: string, i: number): number {
    if (!IDENT_START.test(s.charAt(i))) return -1;
    let j = i + 1;
    while (j < s.length && IDENT_CHAR.test(s.charAt(j))) j++;
    return j;
}

function stringEnd(s: string, i: number): number {
    const q = s.charAt(i);
    for (let j = i + 1; j < s.length; j++) {
        if (s.charAt(j) === '\\') {
            j++;
            continue;
        }
        if (s.charAt(j) === q) return j + 1;
    }
    return -1;
}

/** Where the engine stops inside a span readPath read as one path: a `-` or `@` outside brackets, a dot before a combining mark. */
function engineCut(s: string, from: number, to: number): number {
    let depth = 0;
    for (let j = from; j < to; j++) {
        const c = s.charAt(j);
        if (c === '"' || c === "'") {
            j = stringEnd(s, j) - 1;
            continue;
        }
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (depth === 0 && (c === '-' || c === '@')) return s.charAt(j - 1) === '.' ? j - 1 : j;
        else if (depth === 0 && c === '.' && MARK.test(s.charAt(j + 1))) return j;
    }
    return to;
}

function exprPathEnd(s: string, i: number): number {
    INLINE_HEAD.lastIndex = i;
    if (INLINE_HEAD.test(s)) {
        // The sub-step id is one key; the rest is a path tail behind a stand-in head.
        const head = INLINE_HEAD.lastIndex;
        if (s.charAt(head) !== '.' && s.charAt(head) !== '[') return head;
        const tail = `$${s.slice(head)}`;
        const r = readPath(tail, 0);
        return head + engineCut(tail, 1, r ? r.end : 1) - 1;
    }
    const r = readPath(s, i);
    return r ? engineCut(s, i, r.end) : -1;
}

export type ExprPart = { text: string } | { path: string };

/**
 * Split a formula into text and the paths that start at one of `roots`, in
 * order, concatenating back to the input. Text inside string literals is
 * never a path.
 */
export function scanExprPaths(text: unknown, roots: readonly string[] = REF_ROOTS): ExprPart[] {
    const s = String(text ?? '');
    const rootSet = new Set(roots);
    const out: ExprPart[] = [];
    let last = 0;
    let i = 0;
    while (i < s.length) {
        const c = s.charAt(i);
        if (c === '"' || c === "'") {
            const e = stringEnd(s, i);
            i = e < 0 ? s.length : e;
            continue;
        }
        const wordEnd = identEnd(s, i);
        if (wordEnd < 0) {
            i++;
            continue;
        }
        if ((i > 0 && GLUED.test(s.charAt(i - 1))) || !rootSet.has(s.slice(i, wordEnd))) {
            i = wordEnd;
            continue;
        }
        const end = exprPathEnd(s, i);
        if (i > last) out.push({ text: s.slice(last, i) });
        out.push({ path: s.slice(i, end) });
        last = i = end;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
    return out;
}

/**
 * A field value as an ordered token list. A value containing `{{…}}` is a
 * template (only the insides are refs); fixed mode without one is plain text;
 * expression mode is scanned for bare refs.
 */
export function parseRefTokens(text: unknown, { mode = 'expression' }: { mode?: string } = {}): RefToken[] {
    const s = text == null ? '' : String(text);
    if (!s) return [];
    if (detectTemplate(s)) return tokenizeTemplate(s);
    if (mode === 'fixed') return [{ type: 'literal', text: s }];
    return tokenizeExpression(s);
}

/** Concatenate tokens back into the original string (round-trip safe). */
export function serializeRefTokens(tokens: unknown): string {
    if (!Array.isArray(tokens)) return '';
    return (tokens as RefToken[]).map((tok) => (tok.type === 'literal' ? tok.text : tok.raw)).join('');
}

/** Does this value contain at least one renderable ref? */
export function hasRefTokens(text: unknown, mode?: string): boolean {
    return parseRefTokens(text, { mode }).some((tok) => tok.type === 'ref');
}

export interface ChipLabel {
    name: string;
    suffix: string;
    missing: boolean;
}

/** Id → step label, as the inspector keeps it. */
export type StepLabelMap = Pick<Map<string, string>, 'has' | 'get'> | null | undefined;

/**
 * The display label for a ref token. `missing` is true only for a steps ref
 * whose id is not in the definition any more (a deleted step).
 */
function loopChipName(itemVar: string | undefined): string {
    return itemVar
        ? t('automations.builder.each_named', 'Each {name}', { name: itemVar })
        : t('automations.canvas.loop_each_item', 'Each item');
}

function stepChip(id: string, fieldPath: string | undefined, labels: StepLabelMap): ChipLabel {
    return { name: labels?.get?.(id) || id, suffix: fieldPath || '', missing: !labels?.has?.(id) };
}

export function resolveChipLabel(
    token: (Partial<RefInfo> & { path?: string }) | null | undefined,
    stepLabelById: StepLabelMap = null,
): ChipLabel {
    if (!token) return { name: '', suffix: '', missing: false };
    const suffix = token.fieldPath || '';
    if (token.source === 'steps') return stepChip(token.stepId as string, suffix, stepLabelById);
    if (token.source === 'trigger') return { name: t('automations.node.trigger.defaultLabel', 'Trigger'), suffix, missing: false };
    if (token.source === 'loop') return { name: loopChipName(token.itemVar), suffix, missing: false };
    return { name: token.path || '', suffix: '', missing: false };
}
