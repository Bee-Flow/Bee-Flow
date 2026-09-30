/**
 * The rows grid's geometry. A phone never has the width for a table's columns,
 * so each gets a fixed width by type and the grid scrolls sideways; a yes/no
 * needs a fraction of what a long text does.
 */

import type { Column } from './types';

const WIDTH: Readonly<Record<string, number>> = {
    bool: 72,
    number: 100,
    date: 112,
    datetime: 148,
    select: 132,
    multiselect: 168,
    richtext: 220,
    file: 140,
};

export const DEFAULT_WIDTH = 164;
/** The "Added" column the web's row browser ends on. */
export const ADDED_WIDTH = 132;
/** Cell gap and horizontal padding, as DataListRow lays them out. */
const GAP = 12;
const PADDING = 28;

export function columnWidth(column: Pick<Column, 'type'>): number {
    return WIDTH[column.type] ?? DEFAULT_WIDTH;
}

/** The grid's full content width: every column, the Added column, the gaps and the padding. */
export function gridWidth(columns: readonly Pick<Column, 'type'>[]): number {
    const cells = columns.reduce((sum, c) => sum + columnWidth(c), ADDED_WIDTH);
    return cells + GAP * columns.length + PADDING;
}

/** A stored timestamp as "2026-03-14 09:30" — its own spelling, never shifted by a time zone. */
export function stampText(value: unknown): string {
    const text = typeof value === 'string' ? value : '';
    return text ? text.replace('T', ' ').slice(0, 16) : '—';
}
