import { isFill } from '../../styleResolver.helpers';
import { isActiveFilter } from '../gridColumnFilters';
import { PAGE_SIZE_OPTIONS, VIRTUALIZE_FALLBACK_PX } from './gridConstants';
import type { ColumnFiltersState } from '@tanstack/table-core';
import type { VirtualItem } from '@tanstack/react-virtual';
import type { StyledNode } from '../../styleResolver.types';

/**
 * Pure layout decisions of the App Studio data grid: the look, the page-size
 * list, the filter and range counts, the virtual padding and the box the grid
 * lays itself out in. Moved out of AppDataGrid.tsx verbatim.
 */

// Look pass (spec: data_grid.look). IDENTITY FIRST: 'default' — and any
// value this build does not know yet — takes the exact original code path:
// no new class, no new style. The legacy `zebra` boolean keeps striping
// stored grids, but only on the default look — `look` wins when both are
// set (spec comment in componentSpecs.js).
export function gridLookFor(viewLook: string | undefined, zebra: boolean) {
    const look = viewLook === 'striped' || viewLook === 'minimal' || viewLook === 'cards' ? viewLook : 'default';
    return {
        minimal: look === 'minimal',
        cards: look === 'cards',
        striped: look === 'striped' || (look === 'default' && zebra),
    };
}

// The spec lets an author pick any pageSize from 5 to 100, but the footer
// only offered four. A grid authored at 20 rendered a <select> with no
// matching <option> — blank, until the viewer picked something else and
// lost the author's setting. Whatever is actually in force is always on
// the list.
export function pageSizeChoicesFor(pageSize: number): number[] {
    return PAGE_SIZE_OPTIONS.includes(pageSize) ? PAGE_SIZE_OPTIONS : [...PAGE_SIZE_OPTIONS, pageSize].sort((a, b) => a - b);
}

// Both filter surfaces count: the per-column row and the search box. A grid
// filtered to nothing by a forgotten search box looks exactly like a grid
// filtered to nothing by a column, and the way out is the same.
export function activeFiltersOf(columnFilters: ColumnFiltersState, globalFilter: string) {
    const activeColumnFilters = columnFilters.filter((f) => isActiveFilter(f.value));
    return { activeColumnFilters, activeFilterCount: activeColumnFilters.length + (globalFilter ? 1 : 0) };
}

// Counts AFTER search/column filters — "1–25 of 340" must describe what the
// viewer is actually looking through, not the unfiltered table.
export function pageRangeOf(filteredCount: number, pageIndex: number, pageSize: number) {
    return {
        rangeFrom: filteredCount === 0 ? 0 : pageIndex * pageSize + 1,
        rangeTo: Math.min(filteredCount, (pageIndex + 1) * pageSize),
    };
}

/** The part of the virtualizer the padding rows read. */
export interface VirtualWindowSource {
    getVirtualItems: () => VirtualItem[];
    getTotalSize: () => number;
}

export function virtualWindowOf(virtualize: boolean, virtualizer: VirtualWindowSource) {
    const virtualItems = virtualize ? virtualizer.getVirtualItems() : null;
    const paddingTop = virtualItems && virtualItems.length ? virtualItems[0].start : 0;
    const paddingBottom = virtualItems && virtualItems.length
        ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;
    return { virtualItems, paddingTop, paddingBottom };
}

// Any explicit height — 'fill' or one of the sm/md/lg/xl tokens — means the
// outer cell already owns a definite box, so the grid lays itself out
// inside it: scroller flexes, chrome and footer hold their ground. Only
// 'auto'/absent leaves the grid free-standing, and then the sole reason to
// box it is the virtualization safety net.
export function gridBoxOf(node: StyledNode, virtualize: boolean) {
    const heightToken = node?.style?.height;
    // `fill` stays a distinct thing from `boxed`: app-fill is the marker class
    // the fill contract is asserted on (AppRenderer.fill.test.jsx), and it
    // means "ask the parent for room". A boxed grid already has its room.
    const fill = isFill(node);
    const boxed = fill || (Boolean(heightToken) && heightToken !== 'auto');
    const gridHeight = boxed ? null : (virtualize ? VIRTUALIZE_FALLBACK_PX : null);
    return { fill, boxed, gridHeight };
}
