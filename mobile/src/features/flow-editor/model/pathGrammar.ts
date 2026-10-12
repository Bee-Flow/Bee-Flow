/**
 * Which text is a reference path, and how it is spelled: the ONE path grammar
 * the runtime resolves (shared/expr path.mjs), plus the two things only the
 * builder holds (a flowlet sub-step id `steps.<call>/<sub>`, and the rule
 * that a dashed name the engine reads as a subtraction is a formula). The
 * web's utils/bindingHelpers.js holds the same functions.
 *
 * Also what a path is NAMED after (pathLabelParts: the leaf key, whose it
 * is, which one), so a pill and every other label read a path alike.
 *
 * It sits in model/ because the condition model (route/) and the display
 * helpers parse paths too and must not import bindings/; bindings/walkPath.ts
 * re-exports it.
 */

import { compile, formatPath, parsePath, scanTemplate, type PathToken } from '@/shared/expr';

// An expanded flowlet's sub-step (`steps.<callId>/<subId>…`): one id whose
// `/` no runtime grammar reads (the prefix is stripped on save).
const INLINE_HEAD_RE = /^steps\.([A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)+)(?=$|[.[])/;
// A path an author can mean starts like a name; `42` or `-x` is a number or a formula.
const NAME_START_RE = /^[\p{L}_$]/u;

/** Tokens of a path TAIL (`.a["b"]`, `[0].x`, ``), or null when it does not continue a path. */
export function tailTokens(rest: string): PathToken[] | null {
    if (!rest) return [];
    if (rest[0] !== '.' && rest[0] !== '[') return null;
    const t = parsePath(`$${rest}`);
    return t ? t.slice(1) : null;
}

/** The tokens of any path the builder may hold (the grammar, plus the flowlet sub-step id). */
export function pathTokensOf(text: unknown): PathToken[] | null {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    const inline = INLINE_HEAD_RE.exec(t);
    if (inline) {
        const tail = tailTokens(t.slice(inline[0].length));
        return tail ? [{ type: 'prop', key: 'steps' }, { type: 'prop', key: inline[1] as string }, ...tail] : null;
    }
    return parsePath(t);
}

/** The tokens of a reference path an author typed or picked, or null. */
export function refPathTokens(text: unknown): PathToken[] | null {
    if (typeof text !== 'string' || !NAME_START_RE.test(text.trim())) return null;
    return pathTokensOf(text);
}

/** The canonical spelling of a reference path (what every insertion writes); other text trimmed. */
export function canonicalRefPath(text: unknown): string {
    const t = String(text ?? '').trim();
    const tokens = pathTokensOf(t);
    if (!tokens) return t;
    const inline = INLINE_HEAD_RE.exec(t);
    if (inline) return `${inline[0]}${formatPath([{ type: 'prop', key: '$' }, ...tokens.slice(2)]).slice(1)}`;
    return formatPath(tokens);
}

/** A `-` outside quotes and brackets: the one name character that is also an operator. */
function dashInName(t: string): boolean {
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < t.length; i++) {
        const c = t.charAt(i);
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '-' && depth === 0) return true;
    }
    return false;
}

type Node = { kind?: string; op?: string; a?: Node; b?: Node; segments?: unknown[] } | null | undefined;

/** Does a dashed path read as a SUBTRACTION someone meant (`total-1`, `a.x-b.y`)? */
function readsAsArithmetic(t: string): boolean {
    if (!dashInName(t)) return false;
    let ast: Node;
    try {
        ast = compile(t).ast as Node;
    } catch {
        return false;
    }
    const operand = (n: Node) => n?.kind === 'num' || (n?.kind === 'path' && (n.segments?.length ?? 0) > 1);
    const walk = (n: Node): boolean =>
        !!n && typeof n === 'object' && ((n.kind === 'binop' && n.op === '-' && operand(n.b)) || walk(n.a) || walk(n.b));
    return walk(ast);
}

/** Does a `{{ … }}` placeholder exist in the text (the runtime's quote-aware scan)? */
export function detectTemplate(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    return scanTemplate(text).some((p) => p.type === 'ref');
}

/** One whole path, no operators (a dashed name that reads as a subtraction is a formula). */
export function isCleanPath(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    if (!refPathTokens(t)) return false;
    return !readsAsArithmetic(t);
}

// Keys that only say "the value of it"; after a match segment the matched value names it.
const GENERIC_VALUE_KEYS = new Set(['value', 'Value', 'val', 'content', 'text']);

function matchName(t: PathToken): string {
    return t.type === 'match' ? (t.value === null ? 'null' : String(t.value)) : '';
}

/** The name a token list ends in: the last real key, skipping `[*]` and indexes. */
export function leafOf(tokens: readonly PathToken[]): string {
    for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i] as PathToken;
        if (t.type === 'wild') continue;
        if (t.type === 'match') return matchName(t);
        if (typeof t.key === 'number') continue;
        const prev = tokens[i - 1];
        if (GENERIC_VALUE_KEYS.has(t.key) && prev?.type === 'match') return matchName(prev);
        return t.key;
    }
    return '';
}

/** The key a path or path TAIL is named after, unquoted ('' when none). */
export function pathLeafKey(pathOrTail: unknown): string {
    const t = String(pathOrTail ?? '').trim();
    if (!t) return '';
    const tokens = t[0] === '[' ? tailTokens(t) : pathTokensOf(t);
    return tokens ? leafOf(tokens) : '';
}

// Leaf keys that name nothing on their own; the label adds whose they are.
const GENERIC_LEAF_KEYS = new Set(['address', 'name', 'id', 'value', 'email', 'type']);
const squash = (k: unknown) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

const isIndexOrWild = (t: PathToken) => t.type === 'wild' || (t.type === 'prop' && typeof t.key === 'number');

/** For a generic leaf, the nearest key above it that says whose it is ('' when none). */
function parentOf(tokens: readonly PathToken[], at: number, leaf: string): string {
    if (!GENERIC_LEAF_KEYS.has(squash(leaf))) return '';
    for (let i = at - 1; i >= 0; i--) {
        const k = tokens[i] as PathToken;
        if (k.type !== 'prop' || typeof k.key !== 'string') continue;
        const s = squash(k.key);
        if (!s || GENERIC_LEAF_KEYS.has(s) || s.includes(squash(leaf))) continue;
        return k.key;
    }
    return '';
}

/**
 * What a pill or chip is named after: the leaf key, for a generic leaf the
 * key that says whose it is (`from.emailAddress.address` → "from"), and an
 * index right after the leaf (`items[0]` → 0). Null when not a path. The
 * web's bindingHelpers.pathLabelParts.
 */
export function pathLabelParts(pathOrTail: unknown): { leaf: string; parent: string; index: number | null } | null {
    const t = String(pathOrTail ?? '').trim();
    if (!t) return null;
    const tokens = t[0] === '[' ? tailTokens(t) : pathTokensOf(t);
    if (!tokens) return null;
    const leaf = leafOf(tokens);
    let at = tokens.length - 1;
    while (at >= 0 && isIndexOrWild(tokens[at] as PathToken)) at--;
    const after = tokens.slice(at + 1).find((x) => x.type === 'prop' && typeof x.key === 'number') as { key: number } | undefined;
    return { leaf, parent: parentOf(tokens, at, leaf), index: after ? after.key : null };
}
