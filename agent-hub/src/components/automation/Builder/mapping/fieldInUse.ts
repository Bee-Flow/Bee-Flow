/**
 * Is a picker row in use by the step being edited? The rows are written with
 * `[*]` (a column of a list: `items[*].meta.ai.verdict.score`) and the step
 * often reads one row of it (`items[0].meta.ai.verdict.score`), spelled any
 * way the grammar allows. Comparing TOKENS, with `[*]` standing for any index,
 * marks every level the step reads — through JSON text too, whose paths need
 * no parse step — instead of stopping at the list.
 */
import { parsePath } from '@shared/expr/path.mjs';
import { pathInUse as pathInUseJs } from './boundPaths';

const pathInUse = pathInUseJs as (path: string, used: Set<string>) => boolean;

type Token = { type: string; key?: unknown; value?: unknown };
type Tree = { path: string; children?: Tree[] };

// The runtime's match rule: text compares without case.
const sameText = (a: unknown, b: unknown) => String(a).localeCompare(String(b), undefined, { sensitivity: 'accent' }) === 0;

/** Does the row's token cover the used one? `[*]` covers any index or entry. */
function covers(row: Token, used: Token | undefined): boolean {
    if (!used) return false;
    if (row.type === 'wild') return used.type === 'wild' || used.type === 'match' || (used.type === 'prop' && typeof used.key === 'number');
    if (row.type === 'match') return used.type === 'match' && String(used.key) === String(row.key) && sameText(used.value, row.value);
    return used.type === 'prop' && String(used.key) === String(row.key);
}

/** Is this row's path (or a value inside it) read by one of the `used` paths? */
export function fieldInUse(path: string, used: Set<string> | null | undefined): boolean {
    if (!used || !used.size || !path) return false;
    if (pathInUse(path, used)) return true;
    const row = parsePath(path) as Token[] | null;
    if (!row) return false;
    for (const u of used) {
        const tokens = parsePath(u) as Token[] | null;
        if (tokens && tokens.length >= row.length && row.every((t, i) => covers(t, tokens[i]))) return true;
    }
    return false;
}

/**
 * How many fields of a group the step reads: the DEEPEST rows in use, at
 * any level, so reading `verdict.score` and `verdict["reason code"]` counts
 * two, not the one top-level `body` they sit in.
 */
export function countFieldsInUse(fields: readonly Tree[] | null | undefined, used: Set<string> | null | undefined): number {
    if (!used || !used.size) return 0;
    let n = 0;
    const walk = (list: readonly Tree[]) => {
        for (const f of list) {
            if (!f?.path || !fieldInUse(f.path, used)) continue;
            const deeper = (f.children || []).some(c => c?.path && fieldInUse(c.path, used));
            if (deeper) walk(f.children || []);
            else n += 1;
        }
    };
    walk(fields || []);
    return n;
}
