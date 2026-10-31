// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { VIRTUALIZE_FALLBACK_PX } from './gridConstants';
import { activeFiltersOf, gridBoxOf, gridLookFor, pageRangeOf, pageSizeChoicesFor, virtualWindowOf } from './gridLayout';

describe('gridLookFor', () => {
    it('keeps the default look for unknown values and stripes only on zebra', () => {
        expect(gridLookFor('default', false)).toEqual({ minimal: false, cards: false, striped: false });
        expect(gridLookFor('future-look', true)).toEqual({ minimal: false, cards: false, striped: true });
        expect(gridLookFor(undefined, true)).toEqual({ minimal: false, cards: false, striped: true });
    });

    it('lets an explicit look win over zebra', () => {
        expect(gridLookFor('minimal', true)).toEqual({ minimal: true, cards: false, striped: false });
        expect(gridLookFor('cards', true)).toEqual({ minimal: false, cards: true, striped: false });
        expect(gridLookFor('striped', false)).toEqual({ minimal: false, cards: false, striped: true });
    });
});

describe('pageSizeChoicesFor', () => {
    it('returns the stock list when the size is on it', () => {
        expect(pageSizeChoicesFor(25)).toEqual([10, 25, 50, 100]);
    });

    it('adds an authored size in order', () => {
        expect(pageSizeChoicesFor(20)).toEqual([10, 20, 25, 50, 100]);
    });
});

describe('activeFiltersOf', () => {
    it('counts active column filters plus the search box', () => {
        const filters = [{ id: 'a', value: 'x' }, { id: 'b', value: '' }, { id: 'c', value: { min: null, max: 3 } }];
        const out = activeFiltersOf(filters, 'term');
        expect(out.activeColumnFilters.map((f) => f.id)).toEqual(['a', 'c']);
        expect(out.activeFilterCount).toBe(3);
        expect(activeFiltersOf([], '').activeFilterCount).toBe(0);
    });
});

describe('pageRangeOf', () => {
    it('describes the filtered rows on the current page', () => {
        expect(pageRangeOf(0, 0, 25)).toEqual({ rangeFrom: 0, rangeTo: 0 });
        expect(pageRangeOf(340, 0, 25)).toEqual({ rangeFrom: 1, rangeTo: 25 });
        expect(pageRangeOf(30, 1, 25)).toEqual({ rangeFrom: 26, rangeTo: 30 });
    });
});

describe('virtualWindowOf', () => {
    const item = (index: number, start: number, end: number) => ({ key: index, index, start, end, size: end - start, lane: 0 });
    const source = { getVirtualItems: () => [item(3, 120, 160), item(4, 160, 200)], getTotalSize: () => 1000 };

    it('is empty when the grid does not virtualize', () => {
        expect(virtualWindowOf(false, source)).toEqual({ virtualItems: null, paddingTop: 0, paddingBottom: 0 });
    });

    it('pads above the first and below the last visible item', () => {
        const out = virtualWindowOf(true, source);
        expect(out.virtualItems?.map((v) => v.index)).toEqual([3, 4]);
        expect(out.paddingTop).toBe(120);
        expect(out.paddingBottom).toBe(800);
    });

    it('has no padding for an empty window', () => {
        expect(virtualWindowOf(true, { getVirtualItems: () => [], getTotalSize: () => 0 }))
            .toEqual({ virtualItems: [], paddingTop: 0, paddingBottom: 0 });
    });
});

describe('gridBoxOf', () => {
    it('boxes a fill or token height and leaves auto free-standing', () => {
        expect(gridBoxOf({ style: { height: 'fill' } }, false)).toEqual({ fill: true, boxed: true, gridHeight: null });
        expect(gridBoxOf({ style: { height: 'md' } }, true)).toEqual({ fill: false, boxed: true, gridHeight: null });
        expect(gridBoxOf({ style: { height: 'auto' } }, false)).toEqual({ fill: false, boxed: false, gridHeight: null });
    });

    it('gives a free-standing virtualized grid the fallback height', () => {
        expect(gridBoxOf({}, true)).toEqual({ fill: false, boxed: false, gridHeight: VIRTUALIZE_FALLBACK_PX });
    });
});
