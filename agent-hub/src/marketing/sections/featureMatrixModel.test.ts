import { describe, expect, it } from 'vitest';
import { alignCells, cellFor, cellMode, defaultColumnId, mintMatrixId, rowHasContent, visibleGroups } from './featureMatrixModel';

describe('featureMatrixModel', () => {
    it('picks the highlighted column first, else the first one', () => {
        expect(defaultColumnId([{ id: 'a' }, { id: 'b', highlight: true }])).toBe('b');
        expect(defaultColumnId([{ id: 'a' }, { id: 'b' }])).toBe('a');
        expect(defaultColumnId([])).toBeUndefined();
    });

    it('finds a cell by column id and reports its stored index', () => {
        const row = { cells: [{ id: 'b', kind: 'included' }, { id: 'a', kind: 'text', text: 'x' }] };
        expect(cellFor(row, 'a')).toEqual({ cell: row.cells[1], index: 1 });
        expect(cellFor(row, 'zzz')).toBeUndefined();
        expect(cellFor(undefined, 'a')).toBeUndefined();
    });

    it('knows what a cell shows', () => {
        expect(cellMode({ kind: 'included' })).toBe('included');
        expect(cellMode({ kind: 'excluded' })).toBe('excluded');
        expect(cellMode({ kind: 'text', text: 'Up to 5' })).toBe('text');
        expect(cellMode({ kind: 'text', text: ' ' })).toBe('empty');
        expect(cellMode({ kind: 'weird', text: 'still shown' })).toBe('text');
        expect(cellMode(undefined)).toBe('empty');
    });

    it('treats a row as empty without a label and without a filled cell', () => {
        expect(rowHasContent({ label: '', cells: [{ id: 'a', kind: 'text', text: '' }] })).toBe(false);
        expect(rowHasContent({ label: '', cells: [{ id: 'a', kind: 'included' }] })).toBe(true);
        expect(rowHasContent({ label: 'F' })).toBe(true);
    });

    it('keeps stored indices when the public filter drops rows and groups', () => {
        const groups = [
            { id: 'g0', title: 'Empty', rows: [{ id: 'r', label: '' }] },
            { id: 'g1', title: 'Full', rows: [{ id: 'r0', label: '' }, { id: 'r1', label: 'Real' }] },
        ];
        const visible = visibleGroups(groups, false);
        expect(visible.map((v) => v.index)).toEqual([1]);
        expect(visible[0].rows.map((r) => r.index)).toEqual([1]);
        expect(visibleGroups(groups, true)).toHaveLength(2);
    });

    it('re-aligns cells after the columns changed: pruned, padded, in column order', () => {
        const groups = [{ id: 'g', rows: [{ id: 'r', label: 'F', cells: [{ id: 'a', kind: 'included' }, { id: 'gone', kind: 'text', text: 'x' }] }] }];
        const next = alignCells(groups, [{ id: 'b' }, { id: 'a' }]);
        expect(next[0].rows![0].cells).toEqual([{ id: 'b', kind: 'excluded', text: '' }, { id: 'a', kind: 'included' }]);
    });

    it('mints distinct, prefixed ids', () => {
        const ids = new Set(Array.from({ length: 50 }, () => mintMatrixId('col')));
        expect(ids.size).toBe(50);
        expect([...ids][0]).toMatch(/^col-[a-z0-9]+$/);
    });
});
