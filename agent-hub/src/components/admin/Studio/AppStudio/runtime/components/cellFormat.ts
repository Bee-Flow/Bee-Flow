/**
 * How one table / data_grid cell writes its numbers and dates (cellValue.tsx).
 *
 * The app's `format` and the column's `formatOptions` (schema 3) go through the shared
 * formatter. With neither, LEGACY_CELL is exactly what the cell renderer called before: the
 * chart palette's number / currency / percent formatters and toLocaleDateString /
 * toLocaleString on the Date it already parsed.
 *
 * The data-model hook: a cell bound to a field with a display block would pass
 * withFieldDisplay(col.formatOptions, field.display) as the options. Not wired: the display
 * block is not in this branch's data model.
 */

import { LEGACY, formatContext, formatDate, formatNumber, useAppFormat } from '../appFormat';
import type { AppFormat } from '../appFormat';

export interface CellFormatters {
    number: (n: number) => string;
    currency: (n: number) => string;
    percent: (n: number) => string;
    /** `value` is the raw cell value (a calendar date "YYYY-MM-DD" never moves to another day), `d` the Date parsed from it. */
    date: (value: unknown, d: Date) => string;
    datetime: (value: unknown, d: Date) => string;
}

export const LEGACY_CELL: CellFormatters = Object.freeze({
    number: LEGACY.number,
    currency: LEGACY.currency,
    percent: LEGACY.percent,
    date: (_value: unknown, d: Date) => LEGACY.date(d),
    datetime: (_value: unknown, d: Date) => LEGACY.datetime(d),
});

/** The formatters for one column: LEGACY_CELL itself when neither shape has a key. */
function cellFormatters(app: AppFormat | null, options: unknown): CellFormatters {
    const ctx = formatContext(app, options);
    if (!ctx) return LEGACY_CELL;
    return {
        number: (n) => formatNumber(n, 'number', ctx),
        currency: (n) => formatNumber(n, 'currency', ctx),
        percent: (n) => formatNumber(n, 'percent', ctx),
        date: (value, d) => formatDate(value, 'date', ctx, d) ?? LEGACY.date(d),
        datetime: (value, d) => formatDate(value, 'datetime', ctx, d) ?? LEGACY.datetime(d),
    };
}

/** cellFormatters for a column, with the app's format from the runtime context. */
export function useCellFormatters(col: { formatOptions?: unknown } | null | undefined): CellFormatters {
    return cellFormatters(useAppFormat(), col?.formatOptions);
}
