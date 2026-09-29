// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { rowBands, rowIndexById, ROW_GAP } from './rowBands';

/**
 * Rows derived from positions. The two facts that matter: a fan-out stacked
 * inside one row is ONE band, and a flow that never wrapped yields nothing —
 * so the gutter labels only ever appear where there is a second row.
 */
const card = (id, x, y, number) => ({ id, x, y, width: 240, height: 72, number });

describe('rowBands', () => {
    it('yields nothing for a single row — no label on an unwrapped flow', () => {
        expect(rowBands([card('a', 0, 0, 1), card('b', 320, 0, 2), card('c', 640, 0, 3)])).toEqual([]);
    });

    it('splits at a ROW_GAP and numbers the rows top to bottom', () => {
        const bands = rowBands([
            card('a', 0, 0, 1), card('b', 320, 0, 2),
            card('c', 0, 72 + ROW_GAP, 3), card('d', 320, 72 + ROW_GAP, 4),
            card('e', 0, 2 * (72 + ROW_GAP), 5),
        ]);
        expect(bands.map(b => b.index)).toEqual([1, 2, 3]);
        expect(bands.map(b => b.ids)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
        expect(bands[0]).toMatchObject({ first: 1, last: 2, left: 0, right: 560, top: 0, bottom: 72 });
        expect(bands[1]).toMatchObject({ first: 3, last: 4 });
    });

    it('keeps the two arms of a condition in ONE row', () => {
        // Stacked ranks sit a card height plus one nodesep apart — far less
        // than half a ROW_GAP.
        const bands = rowBands([
            card('trg', 0, 80, 1), card('if', 320, 80, 2),
            card('yes', 640, 0, 3), card('no', 640, 160, 4),
            card('next', 0, 160 + 72 + ROW_GAP, 5),
        ]);
        expect(bands.length).toBe(2);
        expect(bands[0].ids).toEqual(['yes', 'trg', 'if', 'no']);
        expect(bands[0]).toMatchObject({ first: 1, last: 4 });
        expect(bands[1].ids).toEqual(['next']);
    });

    it('a card dragged well below its row joins the next band', () => {
        const bands = rowBands([card('a', 0, 0, 1), card('b', 320, 0, 2), card('c', 640, 400, 3)]);
        expect(bands.length).toBe(2);
        expect(bands[1].ids).toEqual(['c']);
    });

    it('tolerates missing numbers and sizes', () => {
        const bands = rowBands([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 1000 }]);
        expect(bands.length).toBe(2);
        expect(bands[0]).toMatchObject({ first: null, last: null, right: 240, bottom: 72 });
    });

    it('ignores items without a finite position rather than throwing', () => {
        expect(rowBands([{ id: 'a', x: 0, y: 0 }, { id: 'b' }, null])).toEqual([]);
    });

    it('rowIndexById maps every member to its row', () => {
        const bands = rowBands([card('a', 0, 0, 1), card('b', 0, 1000, 2)]);
        const m = rowIndexById(bands);
        expect(m.get('a')).toBe(1);
        expect(m.get('b')).toBe(2);
        expect(m.get('zzz')).toBeUndefined();
        expect(rowIndexById([]).size).toBe(0);
    });
});
