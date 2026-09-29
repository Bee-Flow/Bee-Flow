import { useCallback, useMemo, useState } from 'react';
import { getJSON, setJSON } from '../../../../utils/scopedStorage';
import { EMPTY_PREFS, discoverColumns, resolveShown, suggestColumns, type ColumnPrefs, type OutputColumn } from './columns';

/** How many columns the drawer's narrow table suggests; the large view takes 7. */
const NARROW_MAX = 4;
const WIDE_MAX = 7;

const storageKeyFor = (key: string) => `routines.outputColumns.${key}`;

function readPrefs(key: string | null): ColumnPrefs {
    if (!key) return EMPTY_PREFS;
    try {
        const raw = getJSON<ColumnPrefs>(storageKeyFor(key), null);
        if (!raw || typeof raw !== 'object') return EMPTY_PREFS;
        return {
            shown: Array.isArray(raw.shown) ? raw.shown.filter(k => typeof k === 'string') : null,
            split: Array.isArray(raw.split) ? raw.split.filter(k => typeof k === 'string') : [],
        };
    } catch {
        return EMPTY_PREFS;
    }
}

export interface OutputColumnsState {
    columns: OutputColumn[];
    /** Shown keys for the large view (the choice, else a 7-column suggestion). */
    wide: string[];
    /** Shown keys for the drawer (the choice, else a 4-column suggestion). */
    narrow: string[];
    customised: boolean;
    split: string[];
    setShown: (keys: string[]) => void;
    toggle: (key: string, from: string[]) => void;
    splitGroup: (key: string, from: string[]) => void;
    joinGroup: (key: string, from: string[]) => void;
    showAll: () => void;
    reset: () => void;
}

/**
 * The column choice for one step's output table, remembered per step in the
 * viewer's own storage (scopedStorage). `storageKey` null keeps it in memory.
 */
export default function useOutputColumns(rows: unknown[], storageKey: string | null, usedFields: readonly string[] = []): OutputColumnsState {
    const [prefs, setPrefs] = useState<ColumnPrefs>(() => readPrefs(storageKey));
    const commit = useCallback((next: ColumnPrefs) => {
        setPrefs(next);
        if (storageKey) {
            try { setJSON(storageKeyFor(storageKey), next); } catch { /* storage blocked: keep it for this session */ }
        }
    }, [storageKey]);

    const columns = useMemo(() => discoverColumns(rows, prefs.split), [rows, prefs.split]);
    const wide = useMemo(() => resolveShown(columns, prefs, { max: WIDE_MAX, usedFields }), [columns, prefs, usedFields]);
    const narrow = useMemo(
        () => (prefs.shown ? wide : suggestColumns(columns, { max: NARROW_MAX, usedFields })),
        [prefs.shown, wide, columns, usedFields],
    );

    const setShown = useCallback((keys: string[]) => commit({ ...prefs, shown: keys }), [commit, prefs]);
    const toggle = useCallback((key: string, from: string[]) => {
        const next = from.includes(key) ? from.filter(k => k !== key) : [...from, key];
        commit({ ...prefs, shown: next.length ? next : from });
    }, [commit, prefs]);
    const splitGroup = useCallback((key: string, from: string[]) => {
        const children = discoverColumns(rows, [...prefs.split, key]).filter(c => c.parent === key).map(c => c.key);
        const at = from.indexOf(key);
        const shown = at >= 0 ? [...from.slice(0, at), ...children, ...from.slice(at + 1)] : from;
        commit({ shown, split: [...prefs.split, key] });
    }, [commit, prefs, rows]);
    const joinGroup = useCallback((key: string, from: string[]) => {
        const first = from.findIndex(k => k.startsWith(`${key}.`));
        const rest = from.filter(k => !k.startsWith(`${key}.`));
        const shown = first >= 0 ? [...rest.slice(0, first), key, ...rest.slice(first)] : rest;
        commit({ shown, split: prefs.split.filter(k => k !== key) });
    }, [commit, prefs]);
    const showAll = useCallback(() => commit({ ...prefs, shown: columns.map(c => c.key) }), [commit, prefs, columns]);
    const reset = useCallback(() => commit(EMPTY_PREFS), [commit]);

    return {
        columns, wide, narrow, customised: !!prefs.shown, split: prefs.split,
        setShown, toggle, splitGroup, joinGroup, showAll, reset,
    };
}
