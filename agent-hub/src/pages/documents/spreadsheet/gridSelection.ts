// What a person can do to the SELECTION: click, move, extend, select whole
// columns / rows / the used range. Split from gridActions.ts, which edits.

import type { After, Env, GridActions } from './gridTypes';
import { effectiveRange, type Pos, type Range } from './sheetModel';

const samePos = (a: Pos, b: Pos) => a.col === b.col && a.row === b.row;

type SelectionActions = Pick<GridActions, 'select' | 'extendTo' | 'selectColumns' | 'selectRows' | 'selectColumnsOfSelection' | 'selectRowsOfSelection' | 'selectAll' | 'move' | 'collapse'>;

export function createSelectionActions(env: Env, commit: (after?: After) => void): SelectionActions & { rangeNow: () => Range } {
    const { ui, setUi, latest } = env;
    const clampCol = (c: number) => Math.max(0, Math.min(latest.current.columns - 1, c));
    const clampRow = (r: number) => Math.max(0, Math.min(latest.current.rows - 1, r));
    const clamp = (p: Pos): Pos => ({ col: clampCol(p.col), row: clampRow(p.row) });
    const rangeNow = (): Range => effectiveRange(ui.current.anchor, ui.current.focus, ui.current.whole, latest.current.columns, latest.current.rows);

    const select = (pos: Pos, extend = false) => {
        commit('none');
        const p = clamp(pos);
        setUi({ anchor: extend ? ui.current.anchor : p, focus: p, editing: null, whole: null });
    };
    const selectColumns = (col: number, extend = false) => {
        commit('none');
        const c = clampCol(col);
        setUi({ anchor: { col: extend ? ui.current.anchor.col : c, row: 0 }, focus: { col: c, row: 0 }, editing: null, whole: 'columns' });
    };
    const selectRows = (row: number, extend = false) => {
        commit('none');
        const r = clampRow(row);
        setUi({ anchor: { col: 0, row: extend ? ui.current.anchor.row : r }, focus: { col: 0, row: r }, editing: null, whole: 'rows' });
    };
    const move = (dc: number, dr: number, extend = false) => {
        const cur = ui.current;
        if (extend && cur.whole) {
            // Whole columns grow sideways, whole rows up and down; the other keys do nothing.
            if (cur.whole === 'columns' ? dc === 0 : dr === 0) return false;
            const to = clamp({ col: cur.focus.col + dc, row: cur.focus.row + dr });
            if (samePos(to, cur.focus)) return false;
            setUi({ ...cur, focus: to });
            return true;
        }
        const from = extend ? cur.focus : cur.anchor;
        const to = clamp({ col: from.col + dc, row: from.row + dr });
        if (samePos(to, cur.focus) && (extend || samePos(cur.anchor, to))) return false;
        setUi({ anchor: extend ? cur.anchor : to, focus: to, editing: null, whole: null });
        return true;
    };
    return {
        select, selectColumns, selectRows, move, rangeNow,
        extendTo: (pos) => {
            const cur = ui.current;
            if (cur.editing) return;
            let focus = clamp(pos);
            if (cur.whole === 'columns') focus = { col: focus.col, row: 0 };
            else if (cur.whole === 'rows') focus = { col: 0, row: focus.row };
            setUi({ ...cur, focus });
        },
        collapse: () => setUi({ ...ui.current, focus: ui.current.anchor, whole: null }),
        selectColumnsOfSelection: () => {
            const r = rangeNow();
            setUi({ anchor: { col: r.c1, row: 0 }, focus: { col: r.c2, row: 0 }, editing: null, whole: 'columns' });
        },
        selectRowsOfSelection: () => {
            const r = rangeNow();
            setUi({ anchor: { col: 0, row: r.r1 }, focus: { col: 0, row: r.r2 }, editing: null, whole: 'rows' });
        },
        selectAll: () => {
            const { usedCols, usedRows } = latest.current;
            setUi({ anchor: { col: 0, row: 0 }, focus: { col: clampCol(usedCols - 1), row: clampRow(usedRows - 1) }, editing: null, whole: null });
        },
    };
}
