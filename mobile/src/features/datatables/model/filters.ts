/**
 * The row filter — the server's CLOSED descriptor, as choices.
 *
 * Every operator offered is in the server's FILTER_OPS
 * (core/dataEngine/dataModel/vocabulary), narrowed per column kind the way the
 * web's datatableDisplay.js narrows it; the server checks again anyway
 * (rowDescriptor.readFilters refuses an unknown op by name). Pinned to the web
 * by display.lockstep.test.ts.
 */

import { columnTypeKind } from './columns';
import type { RowFilter } from './types';

export const FILTER_OPS = [
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'contains', 'notContains', 'startsWith', 'endsWith',
    'in', 'notIn', 'between', 'isNull', 'isNotNull',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

const OPS_BY_KIND: Readonly<Record<string, readonly FilterOp[]>> = {
    text: ['eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'notIn', 'isNull', 'isNotNull'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
    date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
    yesno: ['eq', 'neq', 'isNull', 'isNotNull'],
    choice: ['eq', 'neq', 'in', 'notIn', 'isNull', 'isNotNull'],
    list: ['contains', 'notContains', 'isNull', 'isNotNull'],
    file: ['isNull', 'isNotNull'],
    relation: ['eq', 'neq', 'isNull', 'isNotNull'],
    unknown: ['eq', 'neq', 'isNull', 'isNotNull'],
};

/** The operators worth offering for a column. */
export function opsForColumn(column: { type?: string } | null | undefined): readonly FilterOp[] {
    return OPS_BY_KIND[columnTypeKind(column?.type)] ?? OPS_BY_KIND.unknown ?? [];
}

/** `isNull`/`isNotNull` take no value — the row is the whole condition. */
export function opTakesNoValue(op: string): boolean {
    return op === 'isNull' || op === 'isNotNull';
}

/** `in`/`notIn`/`between` take a comma-separated LIST. */
export function opTakesList(op: string): boolean {
    return op === 'in' || op === 'notIn' || op === 'between';
}

/** A condition as it is being built: the value is what was typed. */
export interface FilterDraft {
    field: string;
    op: string;
    value: string;
}

/**
 * One draft → the descriptor entry, or null while it is not answerable. A
 * half-typed condition is never sent: `field = ''` silently returns nothing and
 * reads as "no rows match" rather than "you have not finished".
 */
export function filterEntry(row: FilterDraft | null | undefined): RowFilter | null {
    if (!row?.field || !row.op) return null;
    if (!(FILTER_OPS as readonly string[]).includes(row.op)) return null;
    if (opTakesNoValue(row.op)) return { field: row.field, op: row.op, value: null };
    if (opTakesList(row.op)) {
        const list = String(row.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (row.op === 'between' ? list.length !== 2 : list.length === 0) return null;
        return { field: row.field, op: row.op, value: list };
    }
    const value = row.value;
    if (value === '' || value === null || value === undefined) return null;
    return { field: row.field, op: row.op, value };
}

/** Every answerable draft, as the server's `filters` array. */
export function filterDescriptor(rows: readonly FilterDraft[]): RowFilter[] {
    return rows.map(filterEntry).filter((f): f is RowFilter => f !== null);
}

/** The column types a `?q=` search reaches (rowDescriptor SEARCHABLE_TYPES). */
export const SEARCHABLE_TYPES: readonly string[] = ['text', 'richtext', 'select', 'multiselect'];
