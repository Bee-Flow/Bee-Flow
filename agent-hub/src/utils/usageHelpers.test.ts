// @vitest-environment node
/**
 * The usage dashboard's CSV export neutralises formula cells the way the
 * server's CSV writers do: a cell that starts with = + - @ tab or CR gets a
 * leading apostrophe, so a spreadsheet opening the file shows text, not a
 * formula. Feedback text and names in these exports were typed by other
 * people.
 *
 * Run: cd agent-hub && npx vitest run src/utils/usageHelpers.test.ts
 */
import { describe, it, expect } from 'vitest';
import { rowsToCsv } from './usageHelpers';

const cell = (v: unknown) => rowsToCsv(['x'], [{ x: v }]).split('\n')[1];

describe('rowsToCsv formula neutralisation', () => {
    it.each([
        ['=1+1', "'=1+1"],
        ['+1', "'+1"],
        ['-1', "'-1"],
        ['@SUM(A1)', "'@SUM(A1)"],
        ['\tx', "'\tx"],
    ])('%j starts with an apostrophe', (input, expected) => {
        expect(cell(input)).toBe(expected);
    });

    it('a formula with a comma is still quoted, apostrophe inside the quotes', () => {
        expect(cell('=cmd|"/c calc"!A0, x')).toBe('"\'=cmd|""/c calc""!A0, x"');
    });

    it('ordinary text, numbers and empty cells are untouched', () => {
        expect(cell('hello')).toBe('hello');
        expect(cell(42)).toBe('42');
        expect(cell(null)).toBe('');
        expect(cell('a - b')).toBe('a - b');
    });

    it('headers and row order are kept', () => {
        expect(rowsToCsv(['a', 'b'], [{ a: 1, b: 'x' }, { a: 2, b: 'y' }])).toBe('a,b\n1,x\n2,y');
    });
});
