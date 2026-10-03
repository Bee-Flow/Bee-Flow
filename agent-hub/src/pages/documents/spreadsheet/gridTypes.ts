// The types the grid's state and actions share (no code).

import type { MutableRefObject } from 'react';
import type { Computed } from './sheetEngine';
import type { Pos, Whole } from './sheetModel';

export interface Editing { col: number; row: number; draft: string; origin: 'grid' | 'bar' }
/** `whole` set: the selection is whole columns (anchor/focus columns) or whole rows (anchor/focus rows). */
export interface Ui { anchor: Pos; focus: Pos; editing: Editing | null; whole: Whole }
/** Where the selection goes when an edit is committed. */
export type After = 'down' | 'up' | 'right' | 'left' | 'none';

export interface GridActions {
    select: (pos: Pos, extend?: boolean) => void;
    extendTo: (pos: Pos) => void;
    /** Whole column `col` (with `extend`: from the anchor column to it). */
    selectColumns: (col: number, extend?: boolean) => void;
    selectRows: (row: number, extend?: boolean) => void;
    /** Ctrl+Space / Shift+Space: the columns / rows of what is selected. */
    selectColumnsOfSelection: () => void;
    selectRowsOfSelection: () => void;
    /** Ctrl+A: the used range. */
    selectAll: () => void;
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
    /** Ctrl+D / Ctrl+R: fill the first row / column of the selection over it. */
    fillDown: () => void;
    fillRight: () => void;
    /** Alt+=: a SUM of the numbers next to the selection. */
    autoSum: () => void;
}

/** What the actions read at the moment they run (kept current by the hook). */
export interface Latest {
    cells: Record<string, string>;
    computed?: Computed;
    readOnly: boolean;
    columns: number;
    rows: number;
    usedRows: number;
    usedCols: number;
    onCommit: (changes: Record<string, string>) => void;
}

export interface Env {
    ui: MutableRefObject<Ui>;
    setUi: (next: Ui) => void;
    latest: MutableRefObject<Latest>;
    addRows: () => void;
}
