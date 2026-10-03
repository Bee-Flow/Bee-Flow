import { describe, expect, it } from 'vitest';
import { parseTsv, referencedNames, toTsv, usedRowsOf } from './sheetModel';

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
