/**
 * A column of a list INSIDE a list reached from outside the step's own item:
 * by its full path while the step runs per outer item (relativeToItem), or
 * into a step that does not run per item yet (innerForEachPick). See
 * deepenForEach.ts for the move itself.
 *
 * Port of agent-hub `Builder/mapping/innerList.ts`; deepen.lockstep.test.ts holds the two together.
 */
import { formatPath, getPath } from '@/shared/expr';

import type { ForEachConfig, ForEachParent } from './itemRefs';
import { isWild, lastKeyOf, parse, sameTok, suffixText } from './pathTokens';
import { suggestItemVar, uniqueItemVar } from './upstream/loops';

/**
 * A step that already runs once per OUTER item, given the same list's column
 * by its full path (`steps.shop.output.orders[*].line_items[*].sku` while it
 * runs over `steps.shop.output.orders`): the same value read through the item
 * (`loop.order.line_items[*].sku`), so the pick deepens instead of joining.
 * Null when the path is not under the step's list.
 */
export function relativeToItem(path: string, fe: ForEachConfig | null | undefined): string | null {
    const over = parse(String(fe?.overRef || ''));
    const t = parse(String(path || ''));
    if (!over || !t || !fe?.itemVar || t.length <= over.length + 1) return null;
    if (!over.every((tok, i) => sameTok(tok, t[i]))) return null;
    const rest = t.slice(over.length);
    // `<over>[*]…` when the list is a plain list; `<over>.…` when the overRef
    // already ends on a record per item (`results[*].output`).
    const after = isWild(rest[0]) ? rest.slice(1) : (over.some(isWild) ? rest : null);
    if (!after || !after.length) return null;
    return `loop.${fe.itemVar}${suffixText(after)}`;
}

/**
 * A column of a list INSIDE a list (`steps.shop.output.orders[*].line_items[*].sku`)
 * picked into a one-value field of a step that does not run per item yet:
 * one run per INNER item (every line item of every order), with the outer
 * items kept as parents. Null for anything else — a single-level column is
 * mismatch.js's ordinary "a separate run for each" answer.
 */
export function innerForEachPick(path: string, sampleRoot: unknown = null): {
    forEach: ForEachConfig; binding: { kind: 'ref'; path: string }; itemVar: string; runs: number | null;
} | null {
    const t = parse(String(path || '').trim());
    if (!t) return null;
    const wilds: number[] = [];
    t.forEach((tok, i) => { if (isWild(tok)) wilds.push(i); });
    if (wilds.length < 2) return null;
    const last = wilds[wilds.length - 1];
    if (last === t.length - 1) return null;
    const names: string[] = [];
    const parents: ForEachParent[] = [];
    for (const w of wilds.slice(0, -1)) {
        const name = uniqueItemVar(suggestItemVar(lastKeyOf(t.slice(0, w))), names);
        names.push(name);
        parents.push({ itemVar: name, overRef: formatPath(t.slice(0, w)) as string });
    }
    const itemVar = uniqueItemVar(suggestItemVar(lastKeyOf(t.slice(0, last))), names);
    const overRef = formatPath(t.slice(0, last)) as string;
    const list: unknown = sampleRoot ? getPath(sampleRoot, overRef) : undefined;
    return {
        forEach: { overRef, itemVar, maxIterations: 100, parents },
        binding: { kind: 'ref', path: `loop.${itemVar}${suffixText(t.slice((last ?? 0) + 1))}` },
        itemVar,
        runs: Array.isArray(list) ? list.length : null,
    };
}

