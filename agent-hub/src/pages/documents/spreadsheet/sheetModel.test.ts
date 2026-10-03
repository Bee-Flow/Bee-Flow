import { describe, expect, it } from 'vitest';
import { clipToUsed, effectiveRange, kindOf, parseTsv, referencedNames, selectionFor, toTsv, usedColsOf, usedRowsOf } from './sheetModel';

describe('tab-separated text', () => {
    it('round-trips rows, empty fields and quoted fields', () => {
        const rows = [['a', '', 'c'], ['x\ty', 'line1\nline2', 'say "hi"'], ['=IF(A1,"a","b")', '', '']];
        expect(parseTsv(toTsv(rows))).toEqual(rows);
    });

    it('reads Windows line endings and ignores the final newline', () => {
        expect(parseTsv('1\t2\r\n3\t4\r\n')).toEqual([['1', '2'], ['3', '4']]);
    });

    it('reads a single value and nothing', () => {
        expect(parseTsv('hello')).toEqual([['hello']]);
        expect(parseTsv('')).toEqual([]);
    });

    it('leaves a quote in the middle of a field alone', () => {
        expect(parseTsv('5" pipe\tok')).toEqual([['5" pipe', 'ok']]);
    });
});

describe('referencedNames', () => {
    it('lists single cells and expands ranges', () => {
        expect([...referencedNames('=SUM(A1:B2)+C3')].sort()).toEqual(['A1', 'A2', 'B1', 'B2', 'C3']);
    });

    it('ignores function names that look like cells, strings and plain text', () => {
        expect(referencedNames('=LOG10(A1)').has('LOG10')).toBe(false);
        expect([...referencedNames('=IF(A1,"B2","C3")')]).toEqual(['A1']);
        expect(referencedNames('A1+B1').size).toBe(0);
    });

    it('reads a half-typed formula', () => {
        expect([...referencedNames('=A1+B')]).toEqual(['A1']);
    });
});

describe('usedRowsOf', () => {
    it('is the last row holding something, never less than the server said', () => {
        expect(usedRowsOf({ A1: 'x', C7: '1', D9: '' })).toBe(7);
        expect(usedRowsOf({ A1: 'x' }, 12)).toBe(12);
    });
});

describe('selection kinds', () => {
    const col = effectiveRange({ col: 2, row: 0 }, { col: 3, row: 0 }, 'columns', 26, 50);
    const row = effectiveRange({ col: 0, row: 2 }, { col: 0, row: 4 }, 'rows', 26, 50);

    it('spreads whole columns and rows over the visible sheet', () => {
        expect(col).toEqual({ c1: 2, r1: 0, c2: 3, r2: 49 });
        expect(row).toEqual({ c1: 0, r1: 2, c2: 25, r2: 4 });
        expect(kindOf(col, 'columns')).toBe('columns');
        expect(kindOf({ c1: 1, r1: 1, c2: 1, r2: 1 }, null)).toBe('cell');
        expect(kindOf({ c1: 1, r1: 1, c2: 2, r2: 1 }, null)).toBe('range');
    });

    it('sends a bounded A1 range: columns to the used rows, rows over the full width', () => {
        expect(selectionFor(col, 'columns', 12, 26)).toBe('C1:D12');
        expect(selectionFor(col, 'columns', 0, 26)).toBe('C1:D1');
        expect(selectionFor(row, 'rows', 12, 26)).toBe('A3:Z5');
        expect(selectionFor({ c1: 1, r1: 1, c2: 3, r2: 8 }, 'range', 12, 26)).toBe('B2:D9');
        expect(selectionFor({ c1: 1, r1: 1, c2: 1, r2: 1 }, 'cell', 12, 26)).toBe('B2');
    });

    it('cuts a whole selection to the used part and counts the used columns', () => {
        expect(clipToUsed(col, 'columns', 12, 4)).toEqual({ c1: 2, r1: 0, c2: 3, r2: 11 });
        expect(clipToUsed(row, 'rows', 12, 4)).toEqual({ c1: 0, r1: 2, c2: 3, r2: 4 });
        expect(usedColsOf({ A1: '1', D9: 'x', F1: '' })).toBe(4);
    });
});
