// The shared formula engine (server/shared/expr/sheet.mjs, mirrored to
// src/shared/expr/sheet.mjs by `npm run gen:shared`) behind explicit types, so
// the rest of the spreadsheet code never depends on what the .mjs infers.

import * as engine from '@shared/expr/sheet.mjs';

/** One computed cell: the value, the error it ended in (or null) and the text to show. */
export interface CellResult { value: unknown; error: string | null; display: string }
export type Computed = Record<string, CellResult>;

interface EngineApi {
    evaluateSheet: (cells: Record<string, string>) => Computed;
    parseCellRef: (ref: string) => { col: number; row: number } | null;
    cellName: (col: number, row: number) => string;
    columnName: (col: number) => string;
    SHEET_FUNCTIONS: unknown;
}
const api = engine as unknown as EngineApi;

export const evaluateSheet = (cells: Record<string, string>): Computed => api.evaluateSheet(cells);
export const parseCellRef = (ref: string): { col: number; row: number } | null => api.parseCellRef(ref);
export const cellName = (col: number, row: number): string => api.cellName(col, row);
export const columnName = (col: number): string => api.columnName(col);

/** The names of the functions a formula may call, whatever shape the catalogue has. */
export function functionNames(): string[] {
    const list = api.SHEET_FUNCTIONS;
    let names: unknown[] = [];
    if (Array.isArray(list)) names = list.map((f) => (typeof f === 'string' ? f : (f as { name?: string } | null)?.name));
    else if (list && typeof list === 'object') names = Object.keys(list);
    return names.filter((n): n is string => typeof n === 'string' && n !== '').sort();
}
