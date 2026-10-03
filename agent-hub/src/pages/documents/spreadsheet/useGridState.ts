// The grid's own state: which cell is selected (and the range around it), the
// edit in progress, how many rows are shown. It is shared by the grid and the
// formula bar, so typing in either edits the same draft.
//
// `actions` has a stable identity and reads the latest state through refs, so
// the memoised cells never re-render because a handler changed.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createGridActions, type Latest, type Ui } from './gridActions';
import { cellName } from './sheetEngine';
import { ADD_ROWS, COLUMNS, MIN_ROWS, ROWS_MARGIN, inRange, rangeOf } from './sheetModel';

export type { After, Editing, GridActions } from './gridActions';

export interface GridOptions {
    cells: Record<string, string>;
    readOnly: boolean;
    usedRows: number;
    columns?: number;
    onCommit: (changes: Record<string, string>) => void;
}

const INITIAL: Ui = { anchor: { col: 0, row: 0 }, focus: { col: 0, row: 0 }, editing: null };

export default function useGridState(options: GridOptions) {
    const columns = Math.max(1, Math.min(options.columns ?? COLUMNS, COLUMNS));
    const [added, setAdded] = useState(0);
    const rows = Math.max(options.usedRows + ROWS_MARGIN, MIN_ROWS) + added;

    const [ui, setUiState] = useState<Ui>(INITIAL);
    const uiRef = useRef<Ui>(INITIAL);
    const setUi = useCallback((next: Ui) => { uiRef.current = next; setUiState(next); }, []);
    const latest = useRef<Latest>({ cells: options.cells, readOnly: options.readOnly, onCommit: options.onCommit, columns, rows });
    useLayoutEffect(() => {
        latest.current = { cells: options.cells, readOnly: options.readOnly, onCommit: options.onCommit, columns, rows };
    });

    const actions = useMemo(
        () => createGridActions({ ui: uiRef, setUi, latest, addRows: () => setAdded((n) => n + ADD_ROWS) }),
        [setUi],
    );

    const range = useMemo(() => rangeOf(ui.anchor, ui.focus), [ui.anchor, ui.focus]);
    const activeName = cellName(ui.anchor.col, ui.anchor.row);
    return {
        columns, rows, range, actions, activeName,
        active: ui.anchor,
        editing: ui.editing,
        activeRaw: options.cells[activeName] ?? '',
        isInRange: (col: number, row: number) => inRange(range, col, row),
    };
}

export type GridState = ReturnType<typeof useGridState>;
