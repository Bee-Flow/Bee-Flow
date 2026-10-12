/**
 * Path tokens for the per-item moves (deepenForEach.ts, itemRefs.ts,
 * innerList.ts): read and written with the runtime grammar
 * (shared/expr/path.mjs), so `["line-items"]`, `[name="Subject"]` and `[*]`
 * are steps like any other.
 */
import { formatPath, parsePath } from '@shared/expr/path.mjs';

/** One step of a path, as shared/expr/path.mjs parsePath reads it. */
export type Tok = { type: 'prop'; key: string | number } | { type: 'wild' } | { type: 'match'; key: string; value: string | number | boolean | null };
export const isWild = (t: Tok | undefined) => !!t && t.type === 'wild';
export const keyOf = (t: Tok | undefined) => (t && t.type !== 'wild' ? t.key : undefined);
export const sameTok = (a: Tok | undefined, b: Tok | undefined): boolean => !!a && !!b && a.type === b.type
    && (a.type === 'wild' || (keyOf(a) === keyOf(b) && (a.type !== 'match' || a.value === (b as { value?: unknown }).value)));
export const parse = (p: string): Tok[] | null => parsePath(p) as Tok[] | null;

/** Tokens of a path relative to some base (`line_items[*].sku`, `["line-items"]`). */
export function relTokens(rel: string): Tok[] | null {
    if (!rel) return [];
    const t = parse(rel.startsWith('[') ? `$${rel}` : `$.${rel}`);
    return t ? t.slice(1) : null;
}

/** Relative tokens back to text: `line_items[*].properties`, `["line-items"]`. */
export function relText(tokens: Tok[]): string {
    return formatPath(tokens) as string;
}

/** Tokens that FOLLOW a base, as a suffix: `.sku`, `["unit price"]`, `[0].x`. */
export function suffixText(tokens: Tok[]): string {
    return tokens.length ? (formatPath([{ type: 'prop', key: '$' }, ...tokens]) as string).slice(1) : '';
}

/** `base` + a relative path. */
export function joinRel(base: string, rel: string): string {
    if (!rel) return base;
    return rel.startsWith('[') ? `${base}${rel}` : `${base}.${rel}`;
}

export function lastKeyOf(tokens: Tok[]): string {
    for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t && t.type === 'prop' && typeof t.key === 'string') return t.key;
    }
    return 'item';
}

/** The `[*]` levels of a list path, outermost first: `a[*].b[*].c` → ['a', 'a[*].b']. */
export function listLevels(tokens: Tok[]): string[] {
    const out: string[] = [];
    tokens.forEach((tok, i) => { if (isWild(tok)) out.push(formatPath(tokens.slice(0, i)) as string); });
    return out;
}

/** A path in its canonical spelling; null when it is not a path. */
export function canonical(path: string): string | null {
    const t = parse(String(path || ''));
    return t ? (formatPath(t) as string) : null;
}
