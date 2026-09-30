/**
 * The React keys of RowsEditor's rows. A row keeps its key through a rename
 * and through a pending row joining the map, so it is not remounted: that
 * closed the keyboard after every first character. A removed row's key goes
 * with it, so its half-typed name, its text and its place in the Input tab
 * never pass to the row under it. A key is drawn once and never reused, so
 * two rows never share one.
 */

import { useState } from 'react';

import type { Inputs } from '@/features/flow-editor/schemaForm';

export interface RowKeyState {
    byName: ReadonlyMap<string, string>;
    /** The last key number drawn. */
    drawn: number;
}

/** Every name keyed: the ones without a key draw the next ones. The same state when none is missing. */
export function withKeys(state: RowKeyState, names: readonly string[]): RowKeyState {
    const missing = names.filter((name) => !state.byName.has(name));
    if (!missing.length) return state;
    const byName = new Map(state.byName);
    let drawn = state.drawn;
    for (const name of missing) byName.set(name, `row-${++drawn}`);
    return { byName, drawn };
}

/** `to` now holds `key`; `from`, if given, lets go of it. */
export function handOver(state: RowKeyState, key: string, to: string, from?: string): RowKeyState {
    const byName = new Map(state.byName);
    if (from !== undefined) byName.delete(from);
    byName.set(to, key);
    return { ...state, byName };
}

/** The name `after` has and `before` has not: where a renamed or joining row went. */
export function arrivedName(before: Inputs, after: Inputs): string | undefined {
    return Object.keys(after).find((name) => !Object.prototype.hasOwnProperty.call(before, name));
}

/** A pending row's key, which it keeps when it joins the map. */
export const pendingRowKey = (id: number): string => `new-${id}`;

export interface RowKeys {
    /** The key of the row named `name`. */
    of: (name: string) => string;
    /** The row `from` is now `to` (a rename, an adopted path). */
    rename: (from: string, to: string) => void;
    /** Pending row `id` joined the map as `to`. */
    join: (id: number, to: string) => void;
}

export function useRowKeys(names: readonly string[]): RowKeys {
    const [state, setState] = useState<RowKeyState>(() => withKeys({ byName: new Map(), drawn: 0 }, names));
    // A name from elsewhere (undo, the AI builder) draws its key during render.
    const keyed = withKeys(state, names);
    if (keyed !== state) setState(keyed);
    return {
        of: (name) => keyed.byName.get(name) ?? name,
        rename: (from, to) =>
            setState((s) => {
                const key = s.byName.get(from);
                return key === undefined ? s : handOver(s, key, to, from);
            }),
        join: (id, to) => setState((s) => handOver(s, pendingRowKey(id), to)),
    };
}
