import { useCallback, useMemo, useState } from 'react';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import { getJSON, setJSON } from '../../../../utils/scopedStorage';
import { EMPTY_PREFS, keptChoice, suggestColumns, type ColumnPrefs, type OutputColumn } from './columns';
import { columnsOf } from './perItem';

/** How many columns the drawer's narrow table suggests; the large view takes 7. */
const NARROW_MAX = 4;
const WIDE_MAX = 7;

const storageKeyFor = (key: string) => `automations.outputColumns.${key}`;

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

/**
 * The words of a per-item step's own columns. Set once, here, so every reader
 * (headers, the picker and its search, the technical hint, the details, the
 * crumbs) reads `c.label`.
 */
function withLabels(cols: OutputColumn[], t: TranslateFn): OutputColumn[] {
    if (!cols.some(c => c.perItem && c.perItem !== 'output')) return cols;
    const labels = {
        item: t('automations.ndv.incoming', 'Incoming'),
        result: t('automations.output.col_result', 'Result'),
        problem: t('automations.output.col_problem', 'Problem'),
    };
    return cols.map(c => (c.perItem && c.perItem !== 'output' ? { ...c, label: labels[c.perItem] } : c));
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

const NO_KEYS: readonly string[] = [];

/**
 * The column choice for one step's output table, remembered per step in the
 * viewer's own storage (scopedStorage). `storageKey` null keeps it in memory.
 * `promote` names columns the suggestion shows after the name although they
 * look technical (columns.ts flattenPromotedKeys: a flatten's ids).
 */
export default function useOutputColumns(
    rows: unknown[], storageKey: string | null, usedFields: readonly string[] = NO_KEYS, promote: readonly string[] = NO_KEYS,
): OutputColumnsState {
    const { t } = useTranslation();
    const [prefs, setPrefs] = useState<ColumnPrefs>(() => readPrefs(storageKey));
    const commit = useCallback((next: ColumnPrefs) => {
        setPrefs(next);
        if (storageKey) {
            try { setJSON(storageKeyFor(storageKey), next); } catch { /* storage blocked: keep it for this session */ }
        }
    }, [storageKey]);

    const columns = useMemo(() => withLabels(columnsOf(rows, prefs.split), t), [rows, prefs.split, t]);
    // A choice the data no longer supports (or a stale per-item one) counts as no choice.
    const kept = useMemo(() => keptChoice(columns, prefs), [columns, prefs]);
    const wide = useMemo(() => kept ?? suggestColumns(columns, { max: WIDE_MAX, usedFields, promote }), [kept, columns, usedFields, promote]);
    const narrow = useMemo(() => kept ?? suggestColumns(columns, { max: NARROW_MAX, usedFields, promote }), [kept, columns, usedFields, promote]);

    const setShown = useCallback((keys: string[]) => commit({ ...prefs, shown: keys }), [commit, prefs]);
    const toggle = useCallback((key: string, from: string[]) => {
        const next = from.includes(key) ? from.filter(k => k !== key) : [...from, key];
        commit({ ...prefs, shown: next.length ? next : from });
    }, [commit, prefs]);
    const splitGroup = useCallback((key: string, from: string[]) => {
        const children = columnsOf(rows, [...prefs.split, key]).filter(c => c.parent === key).map(c => c.key);
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
        columns, wide, narrow, customised: !!kept, split: prefs.split,
        setShown, toggle, splitGroup, joinGroup, showAll, reset,
    };
}
