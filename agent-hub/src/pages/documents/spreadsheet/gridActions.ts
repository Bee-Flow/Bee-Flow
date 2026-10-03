// What a person can do to the grid, as plain functions over the grid's state
// (selection, edit in progress, the latest cells). useGridState.ts owns the
// state; nothing here renders.

import type { MutableRefObject } from 'react';
import { cellName } from './sheetEngine';
import { parseTsv, rangeOf, toTsv, type Pos, type Range } from './sheetModel';

export interface Editing { col: number; row: number; draft: string; origin: 'grid' | 'bar' }
export interface Ui { anchor: Pos; focus: Pos; editing: Editing | null }
/** Where the selection goes when an edit is committed. */
export type After = 'down' | 'up' | 'right' | 'left' | 'none';

export interface GridActions {
    select: (pos: Pos, extend?: boolean) => void;
    extendTo: (pos: Pos) => void;
    /** Move by a step; true when the selection moved. */
    move: (dc: number, dr: number, extend?: boolean) => boolean;
    collapse: () => void;
    startEdit: (mode: 'keep' | 'replace', char?: string) => void;
    /** Set the draft; from the formula bar it starts the edit when there is none. */
    setDraft: (value: string, origin: 'grid' | 'bar') => void;
    commit: (after?: After) => void;
    cancel: () => void;
    clear: () => void;
    copyText: () => string;
    cut: () => string;
    paste: (text: string) => void;
    addRows: () => void;
}

/** What the actions read at the moment they run (kept current by the hook). */
export interface Latest {
    cells: Record<string, string>;
    readOnly: boolean;
    columns: number;
    rows: number;
    onCommit: (changes: Record<string, string>) => void;
}

export interface Env {
    ui: MutableRefObject<Ui>;
    setUi: (next: Ui) => void;
    latest: MutableRefObject<Latest>;
    addRows: () => void;
}

const STEPS: Record<After, [number, number]> = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0], none: [0, 0] };
const samePos = (a: Pos, b: Pos) => a.col === b.col && a.row === b.row;

function eachCell(r: Range, fn: (col: number, row: number) => void) {
    for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) fn(col, row);
}

export function createGridActions(env: Env): GridActions {
    const { ui, setUi, latest } = env;
    const clamp = (p: Pos): Pos => ({
        col: Math.max(0, Math.min(latest.current.columns - 1, p.col)),
        row: Math.max(0, Math.min(latest.current.rows - 1, p.row)),
    });
    const rangeNow = (): Range => rangeOf(ui.current.anchor, ui.current.focus);
    const rawAt = (col: number, row: number) => latest.current.cells[cellName(col, row)] ?? '';
    const emit = (changes: Record<string, string>) => { if (Object.keys(changes).length) latest.current.onCommit(changes); };

    const commit = (after: After = 'none') => {
        const ed = ui.current.editing;
        if (!ed) return;
        if (ed.draft !== rawAt(ed.col, ed.row)) emit({ [cellName(ed.col, ed.row)]: ed.draft });
        const [dc, dr] = STEPS[after];
        const pos = clamp({ col: ed.col + dc, row: ed.row + dr });
        setUi({ anchor: pos, focus: pos, editing: null });
    };
    const select = (pos: Pos, extend = false) => {
        commit('none');
        const p = clamp(pos);
        setUi({ anchor: extend ? ui.current.anchor : p, focus: p, editing: null });
    };
    const move = (dc: number, dr: number, extend = false) => {
        const cur = ui.current;
        const from = extend ? cur.focus : cur.anchor;
        const to = clamp({ col: from.col + dc, row: from.row + dr });
        if (samePos(to, cur.focus) && (extend || samePos(cur.anchor, to))) return false;
        setUi({ anchor: extend ? cur.anchor : to, focus: to, editing: null });
        return true;
    };
    const startEdit = (mode: 'keep' | 'replace', char = '') => {
        const cur = ui.current;
        if (latest.current.readOnly || cur.editing) return;
        const { col, row } = cur.anchor;
        setUi({ anchor: cur.anchor, focus: cur.anchor, editing: { col, row, draft: mode === 'keep' ? rawAt(col, row) : char, origin: 'grid' } });
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
        setUi({ anchor: { col: r.c1, row: r.r1 }, focus: { col: lastCol, row: r.r1 + grid.length - 1 }, editing: null });
    };

    return {
        select, move, startEdit, setDraft, commit, clear, copyText, paste, addRows: env.addRows,
        extendTo: (pos) => { if (!ui.current.editing) setUi({ ...ui.current, focus: clamp(pos) }); },
        collapse: () => setUi({ ...ui.current, focus: ui.current.anchor }),
        cancel: () => setUi({ ...ui.current, editing: null }),
        cut: () => { const text = copyText(); clear(); return text; },
    };
}
