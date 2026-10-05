/**
 * Tokenize a bound-field value into literal text and step/trigger/loop
 * REFERENCE tokens, so a field can show `steps.ai_87e358.output.x` as a chip
 * with the step's NAME. Display-only: `serializeRefTokens(parseRefTokens(x))`
 * is `x` for any input. Port of agent-hub `Builder/mapping/refTokens.js`;
 * pinned by refTokens.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';

import { TEMPLATE_RE } from './bindingHelpers';

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const FIELD = '[A-Za-z0-9_$]+(?:\\.[A-Za-z0-9_$]+|\\[[^\\]]*\\])*';

// The lookbehind rejects lookalikes (`mysteps.x`) without consuming a prefix
// character, so the gaps between matches are exactly the literal spans.
const SCAN_RE = new RegExp(
    `(?<![A-Za-z0-9_$.])steps\\.(${IDENT})\\.output(?:\\.(${FIELD}))?` +
        `|(?<![A-Za-z0-9_$.])trigger(?:\\.output)?(?:\\.(${FIELD}))?` +
        `|(?<![A-Za-z0-9_$.])loop\\.(${IDENT})(?:\\.(${FIELD}))?`,
    'g',
);

const STEPS_ANCHOR = new RegExp(`^steps\\.(${IDENT})\\.output(?:\\.(${FIELD}))?$`);
const TRIGGER_ANCHOR = new RegExp(`^trigger(?:\\.output)?(?:\\.(${FIELD}))?$`);
const LOOP_ANCHOR = new RegExp(`^loop\\.(${IDENT})(?:\\.(${FIELD}))?$`);

export interface RefInfo {
    source: 'steps' | 'trigger' | 'loop';
    stepId?: string;
    itemVar?: string;
    fieldPath: string;
}

export type RefToken =
    | { type: 'literal'; text: string }
    | ({ type: 'ref'; raw: string; path: string; wrapped: boolean } & RefInfo);

/** A bare, trimmed path as a ref — or null. */
export function classifyRef(path: unknown): RefInfo | null {
    if (typeof path !== 'string') return null;
    const text = path.trim();
    let m = STEPS_ANCHOR.exec(text);
    if (m) return { source: 'steps', stepId: m[1] as string, fieldPath: m[2] || '' };
    m = LOOP_ANCHOR.exec(text);
    if (m) return { source: 'loop', itemVar: m[1] as string, fieldPath: m[2] || '' };
    m = TRIGGER_ANCHOR.exec(text);
    if (m) return { source: 'trigger', fieldPath: m[1] || '' };
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

function refFromScan(m: RegExpExecArray): RefInfo {
    if (m[1] != null) return { source: 'steps', stepId: m[1], fieldPath: m[2] || '' };
    if (m[4] != null) return { source: 'loop', itemVar: m[4], fieldPath: m[5] || '' };
    return { source: 'trigger', fieldPath: m[3] || '' };
}

function tokenizeExpression(s: string): RefToken[] {
    const tokens: RefToken[] = [];
    SCAN_RE.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = SCAN_RE.exec(s))) {
        if (m.index > last) tokens.push({ type: 'literal', text: s.slice(last, m.index) });
        const full = m[0];
        tokens.push({ type: 'ref', raw: full, path: full, wrapped: false, ...refFromScan(m) });
        last = m.index + full.length;
        if (SCAN_RE.lastIndex === m.index) SCAN_RE.lastIndex++; // zero-width guard
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
 * The display label for a ref token. `missing` is true only for a steps ref
 * whose id is not in the definition any more (a deleted step).
 */
function loopChipName(itemVar: string | undefined): string {
    return itemVar
        ? t('mobile.flow.ref.each_item_named', 'Each {name}', { name: itemVar })
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
