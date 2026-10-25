import type { CSSProperties } from 'react';
import {
    columnFilteringFeature, columnVisibilityFeature, createFilteredRowModel, createPaginatedRowModel,
    createSortedRowModel, globalFilteringFeature, rowPaginationFeature,
    rowSelectionFeature, rowSortingFeature, sortFn_alphanumeric, sortFn_basic,
    sortFn_datetime, sortFn_text, tableFeatures,
} from '@tanstack/react-table';
import { ROLE_COLORS } from '../../styleResolver.constants';

/**
 * The fixed tables of the App Studio data grid: the table features it
 * registers, the page sizes, the density scales, the clamp styles and the
 * row-tone paint. Moved out of AppDataGrid.jsx verbatim.
 */

// The table features this grid uses, registered once (v9 is opt-in per feature).
// sortFns holds exactly what v8's 'auto' sort picks from (datetime, alphanumeric,
// text) plus the 'basic' fallback. Column filters are per-column functions
// (makeFilterFn) and the global search uses the built-in includesString.
export const TABLE_FEATURES = tableFeatures({
    columnFilteringFeature,
    columnVisibilityFeature,
    globalFilteringFeature,
    rowSortingFeature,
    rowPaginationFeature,
    rowSelectionFeature,
    filteredRowModel: createFilteredRowModel(),
    sortedRowModel: createSortedRowModel(),
    paginatedRowModel: createPaginatedRowModel(),
    sortFns: {
        alphanumeric: sortFn_alphanumeric, basic: sortFn_basic,
        datetime: sortFn_datetime, text: sortFn_text,
    },
});

export const VIRTUALIZE_THRESHOLD = 50;
// Page sizes a viewer can pick in the footer. The author's pageSize seeds the
// grid; these are the sizes it can be resized to.
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export const DENSITY: Record<string, { cell: string; text: string; rowH: number }> = {
    compact: { cell: 'px-2 py-1', text: 'text-xs', rowH: 32 },
    comfortable: { cell: 'px-2.5 py-1.5', text: 'text-sm', rowH: 40 },
    spacious: { cell: 'px-3 py-2.5', text: 'text-sm', rowH: 48 },
};
// The 'minimal' look trades rules for whitespace: same density scale, airier
// rows (the dividers are gone, so spacing is what separates the rows).
export const DENSITY_AIRY: Record<string, string> = {
    compact: 'px-2 py-2',
    comfortable: 'px-2.5 py-2.5',
    spacious: 'px-3 py-3',
};
// The ONLY height this file still decides for itself: the safety net for a
// page so long that rendering it inline would jank, when the author asked for
// no height at all.
//
// There used to be a full sm/md/lg/xl map here (160/280/420/620) alongside the
// one in styleResolver (120/200/320/620) — two maps, disagreeing, both applied
// to the same node. The outer (smaller) box won, so the inner scroller was
// capped BELOW its own container: two nested scrollbars, and the pagination
// footer pushed out of sight under the fold. Authors read that as "the grid
// eats my last rows" and worked around it by shrinking pageSize.
//
// Now a node with any explicit height renders like `fill` — the outer cell
// from styleResolver sets the box, the scroller flexes to what is left, and
// the footer keeps its place. One map, one source of truth.
export const VIRTUALIZE_FALLBACK_PX = 280;

// Line clamping, per the viewer's "Long text" choice. -webkit-line-clamp is the
// only cross-browser way to cut at a line boundary rather than a character one,
// and it is supported everywhere this app runs. Height comes back to the row,
// which is what makes a table with one chatty column readable again.
export const CLAMP_STYLE: Record<number, CSSProperties> = {
    1: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 1 },
    2: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 },
    3: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3 },
};

/**
 * How a toned row is painted: a solid bar down its leading edge plus a wash.
 *
 * The bar carries the message. A tint alone is easy to miss on a striped table
 * and disappears entirely for anyone who cannot separate the two colours, so
 * the edge is deliberately a shape change as well as a colour one — you can
 * see which rows are marked from across the room, before reading a word.
 * Kept faint (8%) because the row still has to be READ; this is a flag, not a
 * highlighter.
 */
export function rowToneStyle(tone: string): CSSProperties | undefined {
    const color = (ROLE_COLORS as Record<string, string>)[tone];
    if (!color) return undefined;
    return {
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        boxShadow: `inset 3px 0 0 0 ${color}`,
    };
}

// First rule that matches wins, so an author orders them loudest-first.
// Compared as strings because a select stores '0'/'1' while a number column
// yields 0/1, and a rule that silently never fired would be worse than one
// that is merely blunt.
export function rowToneFor(rowTone: unknown, record: Record<string, unknown> | null | undefined): string | null {
    if (!Array.isArray(rowTone) || !rowTone.length || !record) return null;
    for (const rule of rowTone as Array<{ field?: string; value?: unknown; tone?: string } | null>) {
        if (!rule || !rule.field) continue;
        const cell = record[rule.field];
        if (cell == null) continue;
        if (String(cell) === String(rule.value)) return rule.tone || 'neutral';
    }
    return null;
}
