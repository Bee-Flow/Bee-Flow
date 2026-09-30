/**
 * A JSON value as the rows of a pick list — the web's JsonTreePicker
 * (Builder/mapping/JsonTreePicker.jsx), flattened: each row a key with an
 * example, whose RELATIVE path (the parse_json dialect walkRelativePath
 * resolves on both sides) is what a tap adds. A key a path cannot express is
 * shown but not offered. A list shows its first item, with a "first item /
 * each item" choice that picks `[0]` or `[*]`. Nodes below depth 2 start
 * closed, so a big payload opens readable.
 */

import { joinKeyPath, keyPickable, previewValue } from '@/features/flow-editor/bindings';

export type PickRow =
    | { kind: 'node'; key: string; path: string; depth: number; preview: string; pickable: boolean; hasChildren: boolean; open: boolean }
    | { kind: 'each'; arrayPath: string; each: boolean; depth: number }
    | { kind: 'empty'; depth: number }
    | { kind: 'more'; n: number; depth: number };

export interface PickState {
    /** Nodes whose open state was flipped from the default. */
    toggled: ReadonlySet<string>;
    /** Lists picking from EACH item (`[*]`) rather than the first. */
    each: ReadonlySet<string>;
}

interface Walk {
    state: PickState;
    rows: PickRow[];
    maxDepth: number;
    maxChildren: number;
}

const isNode = (v: unknown): v is object => v !== null && typeof v === 'object';

function hasKids(value: unknown, depth: number, maxDepth: number): boolean {
    if (!isNode(value) || depth >= maxDepth) return false;
    return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
}

function node(w: Walk, at: { key: string; value: unknown; path: string; depth: number; pickable: boolean }): void {
    const hasChildren = hasKids(at.value, at.depth, w.maxDepth);
    const open = hasChildren && (at.depth < 2) !== w.state.toggled.has(at.path);
    w.rows.push({ kind: 'node', key: at.key, path: at.path, depth: at.depth, preview: previewValue(at.value, 40), pickable: at.pickable, hasChildren, open });
    if (open) children(w, { value: at.value, path: at.path, depth: at.depth + 1, pickable: at.pickable });
}

function children(w: Walk, at: { value: unknown; path: string; depth: number; pickable: boolean }): void {
    if (Array.isArray(at.value)) {
        if (at.value.length === 0) {
            w.rows.push({ kind: 'empty', depth: at.depth });
            return;
        }
        const each = w.state.each.has(at.path);
        const idx = each ? '*' : '0';
        w.rows.push({ kind: 'each', arrayPath: at.path, each, depth: at.depth });
        node(w, { key: `[${idx}]`, value: at.value[0], path: `${at.path}[${idx}]`, depth: at.depth, pickable: at.pickable });
        return;
    }
    const entries = Object.entries(at.value as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, w.maxChildren)) {
        node(w, { key: k, value: v, path: joinKeyPath(at.path, k), depth: at.depth, pickable: at.pickable && keyPickable(k) });
    }
    if (entries.length > w.maxChildren) w.rows.push({ kind: 'more', n: entries.length - w.maxChildren, depth: at.depth });
}

/** The rows for a parsed value; none when it is not an object or a list. */
export function pickRows(value: unknown, state: PickState, maxDepth = 20, maxChildren = 200): PickRow[] {
    if (!isNode(value)) return [];
    const w: Walk = { state, rows: [], maxDepth, maxChildren };
    children(w, { value, path: '', depth: 0, pickable: true });
    return w.rows;
}

/** A set with `key` flipped. */
export function flip(set: ReadonlySet<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
}
