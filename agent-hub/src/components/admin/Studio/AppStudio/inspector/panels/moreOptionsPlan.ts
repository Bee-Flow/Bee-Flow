/**
 * What the "More options" block under a bespoke panel shows: every prop of the
 * type's catalog spec the panel does not edit itself, and, for a list the panel
 * does edit, the item keys its own list editor leaves out (one level of lists
 * inside items too, the depth the validator accepts).
 *
 * Pure, so the lockstep test can hold every registered panel to it.
 */

import type { PanelCoverage } from '../registry';
import type { PropSpec } from './specProps';

/** A list inside an item (a column's value→tone map) with the keys left to the block. */
interface NestedListPlan {
    key: string;
    fs: PropSpec;
    extraKeys: string[];
}

/** A list the panel edits, with the item keys left to the block. */
export interface ListPlan {
    key: string;
    fs: PropSpec;
    extraKeys: string[];
    nested: NestedListPlan[];
}

interface MoreOptionsPlan {
    props: string[];
    lists: ListPlan[];
}

/** The path a list inside an item is named by in `PanelCoverage.items`. */
export function nestedPath(listKey: string, itemKey: string) {
    return `${listKey}[].${itemKey}`;
}

function leftOver(shape: Record<string, PropSpec>, handled: readonly string[] | undefined) {
    const done = new Set(handled || []);
    return Object.keys(shape).filter((k) => !done.has(k));
}

function planList(key: string, fs: PropSpec, coverage: PanelCoverage): ListPlan | null {
    const shape = fs.itemShape || {};
    const handled = coverage.items?.[key];
    const extraKeys = leftOver(shape, handled);
    const nested: NestedListPlan[] = [];
    for (const ik of handled || []) {
        const sub = shape[ik];
        if (!sub || sub.type !== 'list' || !sub.itemShape) continue;
        const subExtra = leftOver(sub.itemShape, coverage.items?.[nestedPath(key, ik)]);
        if (subExtra.length) nested.push({ key: ik, fs: sub, extraKeys: subExtra });
    }
    return extraKeys.length || nested.length ? { key, fs, extraKeys, nested } : null;
}

export function planMoreOptions(specProps: Record<string, PropSpec>, coverage: PanelCoverage): MoreOptionsPlan {
    const handled = new Set(coverage.props);
    const props = Object.keys(specProps).filter((k) => !handled.has(k));
    const lists: ListPlan[] = [];
    for (const key of coverage.props) {
        const fs = specProps[key];
        if (!fs || fs.type !== 'list' || !fs.itemShape) continue;
        const plan = planList(key, fs, coverage);
        if (plan) lists.push(plan);
    }
    return { props, lists };
}
