/**
 * A row being added or edited: what each field editor holds, and what goes
 * back to the server.
 *
 * The web replaced a hand-rolled form that typed three of the nine column
 * types (RowBrowser's header lists the damage: a multiselect sent as the
 * string 'a, b', a cleared number sent '' into NUMERIC, an unticked checkbox
 * that never entered `values`). The same rules hold here: every type is
 * converted before it is sent, a yes/no is always sent, and an edit sends
 * only what changed — PUT refuses an empty `values`.
 *
 * Numbers and dates are read the way the import reads them, so a Dutch
 * keyboard's "12,5" and a typed "14-03-2026" land as 12.5 and 2026-03-14.
 */

import { boolValue, dateInputValue, listValue, optionPair } from './cellValues';
import { parseDateish, parseDatetimeish, parseNumberish, type CellErrorCode } from './csvImport';
import type { Column, TableRow } from './types';

/** What one editor holds: text, a switch, or a set of choices. */
export type DraftValue = string | boolean | string[];
export type RowDraft = Record<string, DraftValue>;

/** Columns a person fills in: a file column is a reference the phone cannot pick. */
export function editableColumns(columns: readonly Column[]): Column[] {
    return columns.filter((c) => c.type !== 'file' && c.type !== 'relation' && c.type !== 'unknown');
}

function draftValue(value: unknown, column: Column): DraftValue {
    switch (column.type) {
        case 'bool':
            return value == null ? false : boolValue(value);
        case 'multiselect':
            return listValue(value).map((v) => optionPair(v).value);
        case 'date':
        case 'datetime':
            return dateInputValue(value, column.type);
        default:
            return value == null ? '' : String(value);
    }
}

/** The editors' starting point: a row's values, or empty for a new row. */
export function draftFromRow(row: TableRow | null, columns: readonly Column[]): RowDraft {
    const draft: RowDraft = {};
    for (const column of editableColumns(columns)) draft[column.key] = draftValue(row?.[column.key], column);
    return draft;
}

type Converted = { value: unknown; error: CellErrorCode | null };

function convertText(text: string, column: Column): Converted {
    if (column.type === 'number') {
        const n = parseNumberish(text);
        return Number.isFinite(n) ? { value: n, error: null } : { value: null, error: 'number' };
    }
    if (column.type === 'date') {
        const d = parseDateish(text);
        return d ? { value: d, error: null } : { value: null, error: 'date' };
    }
    if (column.type === 'datetime') {
        const d = parseDatetimeish(text);
        return d ? { value: d, error: null } : { value: null, error: 'datetime' };
    }
    return { value: text, error: null };
}

/** One editor's content as the value the column holds, or why it cannot be. */
export function convertDraftValue(draft: DraftValue | undefined, column: Column): Converted {
    if (column.type === 'bool') return { value: draft === true, error: null };
    if (Array.isArray(draft)) {
        if (!draft.length && column.required) return { value: null, error: 'required' };
        return { value: draft.length ? draft : null, error: null };
    }
    const text = typeof draft === 'string' ? draft.trim() : '';
    if (!text) return { value: null, error: column.required ? 'required' : null };
    return convertText(text, column);
}

export interface DraftCheck {
    values: Record<string, unknown>;
    /** Column key → why its editor's content will not do. */
    errors: Record<string, CellErrorCode>;
}

const same = (a: DraftValue | undefined, b: DraftValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What to send. A new row carries every filled-in column (and every yes/no);
 * an edit carries only the columns whose editor moved, so a colleague's change
 * to another column is not overwritten with what this sheet happened to hold.
 */
export function valuesFromDraft(draft: RowDraft, columns: readonly Column[], original: RowDraft | null): DraftCheck {
    const values: Record<string, unknown> = {};
    const errors: Record<string, CellErrorCode> = {};
    for (const column of editableColumns(columns)) {
        const current = draft[column.key];
        if (original && same(current, original[column.key])) continue;
        const { value, error } = convertDraftValue(current, column);
        if (error) errors[column.key] = error;
        else if (value !== null || original) values[column.key] = value;
    }
    return { values, errors };
}
