// What a person can do to the grid, as plain functions over the grid's state
// (selection, edit in progress, the latest cells). useGridState.ts owns the
// state; nothing here renders. Selecting lives in gridSelection.ts.

import { autoSumChanges, fillChanges } from './gridFill';
import { createSelectionActions } from './gridSelection';
import type { After, Env, GridActions } from './gridTypes';
import { cellName } from './sheetEngine';
import { clipToUsed, parseTsv, toTsv, type Range } from './sheetModel';

export type { After, Editing, Env, GridActions, Latest, Ui } from './gridTypes';

const STEPS: Record<After, [number, number]> = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0], none: [0, 0] };

function eachCell(r: Range, fn: (col: number, row: number) => void) {
    for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) fn(col, row);
}

export function createGridActions(env: Env): GridActions {
    const { ui, setUi, latest } = env;
    const rawAt = (col: number, row: number) => latest.current.cells[cellName(col, row)] ?? '';
    const emit = (changes: Record<string, string>) => { if (Object.keys(changes).length) latest.current.onCommit(changes); };

    const commit = (after: After = 'none') => {
        const ed = ui.current.editing;
        if (!ed) return;
        if (ed.draft !== rawAt(ed.col, ed.row)) emit({ [cellName(ed.col, ed.row)]: ed.draft });
        const [dc, dr] = STEPS[after];
        const col = Math.max(0, Math.min(latest.current.columns - 1, ed.col + dc));
        const row = Math.max(0, Math.min(latest.current.rows - 1, ed.row + dr));
        setUi({ anchor: { col, row }, focus: { col, row }, editing: null, whole: null });
    };
    const sel = createSelectionActions(env, commit);
    const { rangeNow } = sel;

    const startEdit = (mode: 'keep' | 'replace', char = '') => {
        const cur = ui.current;
        if (latest.current.readOnly || cur.editing) return;
        const { col, row } = cur.anchor;
        setUi({ anchor: cur.anchor, focus: cur.anchor, whole: null, editing: { col, row, draft: mode === 'keep' ? rawAt(col, row) : char, origin: 'grid' } });
    };
    const setDraft = (value: string, origin: 'grid' | 'bar') => {
        const cur = ui.current;
        if (latest.current.readOnly) return;
        const ed = cur.editing ?? { col: cur.anchor.col, row: cur.anchor.row, draft: '', origin };
        setUi({ ...cur, editing: { ...ed, draft: value } });
    };
    const clear = () => {
        if (latest.current.readOnly) return;
        const changes: Record<string, string> = {};
        eachCell(rangeNow(), (col, row) => { if (rawAt(col, row) !== '') changes[cellName(col, row)] = ''; });
        emit(changes);
    };
    const copyText = () => {
        const r = rangeNow();
        const out: string[][] = Array.from({ length: r.r2 - r.r1 + 1 }, () => []);
        eachCell(r, (col, row) => out[row - r.r1].push(rawAt(col, row)));
        return toTsv(out);
    };
    const paste = (text: string) => {
        const grid = parseTsv(text);
        if (latest.current.readOnly || !grid.length) return;
        const r = rangeNow();
        const changes: Record<string, string> = {};
        let lastCol = r.c1;
        grid.forEach((line, i) => line.forEach((value, j) => {
            const col = r.c1 + j;
            if (col >= latest.current.columns) return;
            lastCol = Math.max(lastCol, col);
            if (value !== rawAt(col, r.r1 + i)) changes[cellName(col, r.r1 + i)] = value;
        }));
        emit(changes);
        setUi({ anchor: { col: r.c1, row: r.r1 }, focus: { col: lastCol, row: r.r1 + grid.length - 1 }, editing: null, whole: null });
    };
    // Fill and AutoSum work on what holds data: whole columns / rows are cut to the used part.
    const usedRange = () => clipToUsed(rangeNow(), ui.current.whole, latest.current.usedRows, latest.current.usedCols);
    const fill = (direction: 'down' | 'right') => {
        if (!latest.current.readOnly && !ui.current.editing) emit(fillChanges(usedRange(), direction, rawAt));
    };
    const isNumber = (col: number, row: number) => {
        const { computed } = latest.current;
        if (computed) return typeof computed[cellName(col, row)]?.value === 'number';
        const raw = rawAt(col, row).trim();
        return raw !== '' && Number.isFinite(Number(raw));
    };
    const autoSum = () => {
        if (latest.current.readOnly || ui.current.editing) return;
        emit(autoSumChanges(rangeNow(), ui.current.whole, latest.current.usedRows, rawAt, isNumber));
    };

    return {
        ...sel, startEdit, setDraft, commit, clear, copyText, paste, autoSum, addRows: env.addRows,
        fillDown: () => fill('down'), fillRight: () => fill('right'),
        cancel: () => setUi({ ...ui.current, editing: null }),
        cut: () => { const text = copyText(); clear(); return text; },
    };
}
