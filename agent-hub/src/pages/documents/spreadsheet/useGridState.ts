// The grid's own state: which cell is selected (and the range around it), the
// edit in progress, how many rows are shown. It is shared by the grid and the
// formula bar, so typing in either edits the same draft.
//
// `actions` has a stable identity and reads the latest state through refs, so
// the memoised cells never re-render because a handler changed.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createGridActions, type GridLimit, type Latest, type Ui } from './gridActions';
import { cellName, type Computed } from './sheetEngine';
import { ADD_ROWS, COLUMNS, MAX_ROWS, MIN_ROWS, ROWS_MARGIN, effectiveRange, inRange, kindOf, usedColsOf } from './sheetModel';

export type {   GridActions, GridLimit } from './gridActions';

export interface GridOptions {
    cells: Record<string, string>;
    /** The evaluated cells (AutoSum counts numbers by value). */
    computed?: Computed;
    readOnly: boolean;
    usedRows: number;
    columns?: number;
    onCommit: (changes: Record<string, string>) => void;
    onUndo: () => boolean;
    onRedo: () => boolean;
}

const INITIAL: Ui = { anchor: { col: 0, row: 0 }, focus: { col: 0, row: 0 }, editing: null, whole: null };

export default function useGridState(options: GridOptions) {
    const columns = Math.max(1, Math.min(options.columns ?? COLUMNS, COLUMNS));
    const [added, setAdded] = useState(0);
    // Never more rows than the server holds.
    const rows = Math.min(MAX_ROWS, Math.max(options.usedRows + ROWS_MARGIN, MIN_ROWS) + added);
    const [limit, setLimit] = useState<GridLimit | null>(null);

    const [ui, setUiState] = useState<Ui>(INITIAL);
    const uiRef = useRef<Ui>(INITIAL);
    const setUi = useCallback((next: Ui) => { uiRef.current = next; setUiState(next); }, []);
    const usedCols = useMemo(() => usedColsOf(options.cells), [options.cells]);
    const snapshot = (): Latest => ({
        cells: options.cells, computed: options.computed, readOnly: options.readOnly, onCommit: options.onCommit,
        onUndo: options.onUndo, onRedo: options.onRedo,
        columns, rows, usedRows: options.usedRows, usedCols,
    });
    const latest = useRef<Latest>(snapshot());
    useLayoutEffect(() => { latest.current = snapshot(); });

    const actions = useMemo(
        () => createGridActions({
            ui: uiRef, setUi, latest, notify: setLimit,
            addRows: () => {
                if (latest.current.rows >= MAX_ROWS) setLimit({ kind: 'rows' });
                else setAdded((n) => n + ADD_ROWS);
            },
        }),
        [setUi],
    );

    const range = useMemo(() => effectiveRange(ui.anchor, ui.focus, ui.whole, columns, rows), [ui.anchor, ui.focus, ui.whole, columns, rows]);
    const activeName = cellName(ui.anchor.col, ui.anchor.row);
    return {
        columns, rows, range, actions, activeName, usedCols,
        /** What the last paste or "add rows" could not fit, until dismissed. */
        limit, clearLimit: () => setLimit(null),
        kind: kindOf(range, ui.whole),
        active: ui.anchor,
        editing: ui.editing,
        activeRaw: options.cells[activeName] ?? '',
        isInRange: (col: number, row: number) => inRange(range, col, row),
    };
}

export type GridState = ReturnType<typeof useGridState>;
