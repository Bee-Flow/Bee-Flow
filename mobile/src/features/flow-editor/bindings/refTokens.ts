/**
 * Tokenize a bound-field value into literal text and step/trigger/loop/item/
 * vars REFERENCE tokens, so a field can show `steps.ai_87e358.output.x` as a chip
 * with the step's NAME. Display-only: `serializeRefTokens(parseRefTokens(x))`
 * is `x` for any input. Port of agent-hub `Builder/mapping/refTokens.js`;
 * pinned by refTokens.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';
import { sourceFromPath, TRIGGER_RUN_KEYS } from '@/shared/mapping';

import { TEMPLATE_RE } from './bindingHelpers';

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const SEGMENT = '\\.[A-Za-z0-9_$]+|\\[[^\\]]*\\]';
const TAIL = `((?:${SEGMENT})*)`;

// A root word and every segment after it; the lookbehind rejects lookalikes
// (`mysteps.x`) without consuming a prefix character, so the gaps between
// matches are exactly the literal spans; the lookahead keeps a root word
// whole (`items` is no `item` pill). classifyPrefix keeps the longest part
// that is a ref.
const SCAN_RE = new RegExp(`(?<![A-Za-z0-9_$."'])(?:steps|trigger|loop|item|vars)(?![A-Za-z0-9_$])(?:${SEGMENT})*`, 'g');
const SEGMENT_RE = new RegExp(SEGMENT, 'g');

const STEPS_ANCHOR = new RegExp(`^steps\\.(${IDENT})\\.output${TAIL}$`);
const TRIGGER_ANCHOR = new RegExp(`^trigger(\\.output)?${TAIL}$`);
const LOOP_ANCHOR = new RegExp(`^loop\\.(${IDENT})${TAIL}$`);
const ITEM_ANCHOR = new RegExp(`^(item|vars)${TAIL}$`);

const RUN_KEYS = new Set<string>(TRIGGER_RUN_KEYS);

export interface RefInfo {
    source: 'steps' | 'trigger' | 'loop' | 'item' | 'vars';
    stepId?: string;
    itemVar?: string;
    fieldPath: string;
    /** `trigger.<key>` that reads neither the payload nor the trigger's metadata. */
    noOutput?: true;
}

export type RefToken =
    | { type: 'literal'; text: string }
    | ({ type: 'ref'; raw: string; path: string; wrapped: boolean } & RefInfo);

const fieldOf = (tail: string | undefined): string => String(tail || '').replace(/^\./, '');
const firstKey = (tail: string): string => /^\.([A-Za-z0-9_$]+)/.exec(tail)?.[1] ?? '';

/** A bare, trimmed path as a ref — or null. */
export function classifyRef(path: unknown): RefInfo | null {
    if (typeof path !== 'string') return null;
    const text = path.trim();
    let m = STEPS_ANCHOR.exec(text);
    if (m) return { source: 'steps', stepId: m[1] as string, fieldPath: fieldOf(m[2]) };
    m = LOOP_ANCHOR.exec(text);
    if (m) return { source: 'loop', itemVar: m[1] as string, fieldPath: fieldOf(m[2]) };
    m = TRIGGER_ANCHOR.exec(text);
    if (m) {
        const ref: RefInfo = { source: 'trigger', fieldPath: fieldOf(m[2]) };
        if (!m[1] && m[2] && !RUN_KEYS.has(firstKey(m[2]))) ref.noOutput = true;
        return ref;
    }
    m = ITEM_ANCHOR.exec(text);
    if (m && (m[2] === '' || sourceFromPath(text))) return { source: m[1] as 'item' | 'vars', fieldPath: fieldOf(m[2]) };
    return null;
}

/** The longest leading part of a scanned candidate that is a ref, or null. */
function classifyPrefix(candidate: string): { length: number; ref: RefInfo } | null {
    const head = (/^[A-Za-z]+/.exec(candidate) as RegExpExecArray)[0];
    const ends = [head.length];
    SEGMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SEGMENT_RE.exec(candidate.slice(head.length)))) ends.push(head.length + m.index + m[0].length);
    for (let i = ends.length - 1; i >= 0; i--) {
        const ref = classifyRef(candidate.slice(0, ends[i]));
        if (ref) return { length: ends[i] as number, ref };
    }
    return null;
}

function tokenizeTemplate(s: string): RefToken[] {
    const tokens: RefToken[] = [];
    const TPL = /\{\{([^}]*)\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = TPL.exec(s))) {
        if (m.index > last) tokens.push({ type: 'literal', text: s.slice(last, m.index) });
        const full = m[0];
        const inner = (m[1] as string).trim();
        const ref = classifyRef(inner);
        if (ref) tokens.push({ type: 'ref', raw: full, path: inner, wrapped: true, ...ref });
        else tokens.push({ type: 'literal', text: full });
        last = m.index + full.length;
    }
    if (last < s.length) tokens.push({ type: 'literal', text: s.slice(last) });
    return tokens;
}

/**
 * The end of every quoted string literal in an expression, by its start
 * (`"…"`, `'…'`, a backslash escaping the next character; an unclosed one
 * runs to the end). A word inside one is text, never a ref.
 */
function stringEnds(s: string): Map<number, number> {
    const ends = new Map<number, number>();
    for (let i = 0; i < s.length; i++) {
        const q = s[i];
        if (q !== '"' && q !== "'") continue;
        let j = i + 1;
        while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
        ends.set(i, Math.min(j + 1, s.length));
        i = j;
    }
    return ends;
}

function tokenizeExpression(s: string): RefToken[] {
    const tokens: RefToken[] = [];
    const strings = [...stringEnds(s)];
    SCAN_RE.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = SCAN_RE.exec(s))) {
        const at = m.index;
        const inString = strings.find(([start, end]) => start < at && at < end);
        if (inString) {
            SCAN_RE.lastIndex = inString[1];
            continue;
        }
        const hit = classifyPrefix(m[0]);
        if (!hit) continue;
        if (m.index > last) tokens.push({ type: 'literal', text: s.slice(last, m.index) });
        const full = m[0].slice(0, hit.length);
        tokens.push({ type: 'ref', raw: full, path: full, wrapped: false, ...hit.ref });
        last = m.index + full.length;
        SCAN_RE.lastIndex = last;
    }
    if (last < s.length) tokens.push({ type: 'literal', text: s.slice(last) });
    return tokens;
}

/**
 * A field value as an ordered token list. A value containing `{{…}}` is a
 * template (only the insides are refs); fixed mode without one is plain text;
 * expression mode is scanned for bare refs.
 */
export function parseRefTokens(text: unknown, { mode = 'expression' }: { mode?: string } = {}): RefToken[] {
    const s = text == null ? '' : String(text);
    if (!s) return [];
    if (TEMPLATE_RE.test(s)) return tokenizeTemplate(s);
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
 * The display label for a ref token. `missing` is true for a steps ref whose
 * id is not in the definition any more (a deleted step), and for a
 * `trigger.<key>` that reads nothing (`noOutput`).
 */
function loopChipName(itemVar: string | undefined): string {
    return itemVar
        ? t('mobile.flow.ref.loop_item_named', 'Loop item · {name}', { name: itemVar })
        : t('mobile.flow.ref.loop_item', 'Loop item');
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
    if (token.source === 'trigger') return { name: t('routines.node.trigger.defaultLabel', 'Trigger'), suffix, missing: token.noOutput === true };
    if (token.source === 'loop') return { name: loopChipName(token.itemVar), suffix, missing: false };
    if (token.source === 'item') return { name: t('mobile.flow.path.current_row', 'Current row'), suffix, missing: false };
    if (token.source === 'vars') return { name: t('mobile.flow.path.variable', 'Variable'), suffix, missing: false };
    return { name: token.path || '', suffix: '', missing: false };
}
