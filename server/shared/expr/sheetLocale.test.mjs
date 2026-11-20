// Dutch input in spreadsheets: `;` between a function's arguments in every
// locale, and numbers typed the Dutch way (1,5 / 1.234,56 / € 10 / 10%) read
// as numbers in a sheet whose locale is 'nl'.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSheet, evaluateCell, referencedCells, canonicalFormula } from './sheet.mjs';
import { localeNumber, sheetLocale } from './sheetValues.mjs';

const f = (formula, cells = {}, options = {}) => evaluateCell({ ...cells, AAA9: formula }, 'AAA9', options);

describe('; between arguments', () => {
    test('works like , in every locale', () => {
        const cells = { A1: '2', A2: '3' };
        assert.equal(f('=SUM(A1;A2)', cells).value, 5);
        assert.equal(f('=SUM(A1;A2)', cells, { locale: 'nl' }).value, 5);
        assert.equal(f('=SUM(A1,A2)', cells, { locale: 'nl' }).value, 5);
        assert.equal(f('=IF(A1>1;"yes";"no")', cells).value, 'yes');
        assert.equal(f('=ROUND(2.345;2)').value, 2.35);
        assert.equal(f('=SUM(A1;A2,4)', cells).value, 9, 'mixed in one call');
    });
    test('a ; inside a string stays text', () => {
        assert.equal(f('="a;b"').value, 'a;b');
        assert.equal(f('=CONCAT("x;";"y")').value, 'x;y');
        assert.equal(f('=LEN("a;b;c")').value, 5);
    });
    test('a ; outside a call is still a mistake', () => {
        assert.equal(f('=1;2').error, '#ERROR!');
        assert.equal(f('=(1;2)').error, '#ERROR!');
    });
    test('the cells a formula reads are found with ; too', () => {
        assert.deepEqual(referencedCells('=SUM(A1;B2)'), ['A1', 'B2']);
    });
    test('canonicalFormula writes , outside strings (for Excel)', () => {
        assert.equal(canonicalFormula('=SUM(A1;A2)'), '=SUM(A1,A2)');
        assert.equal(canonicalFormula('=IF(A1>1;"a;b";"c""; d")'), '=IF(A1>1,"a;b","c""; d")');
        assert.equal(canonicalFormula('plain;text'), 'plain;text', 'not a formula: untouched');
    });
    test('a decimal comma is NOT a number inside a formula (it separates arguments)', () => {
        assert.equal(f('=SUM(1,5)').value, 6);
        assert.equal(f('=1,5').error, '#ERROR!');
    });
});

describe('localeNumber', () => {
    /** [typed, nl, en] — null means it stays text. */
    const table = [
        ['1,5', 1.5, null],
        ['-3,2', -3.2, null],
        ['1.234,56', 1234.56, null],
        ['1.234.567', 1234567, null],
        ['€ 10', 10, 10],
        ['€10,50', 10.5, null],
        ['10,50 €', 10.5, null],
        ['-€ 10', -10, -10],
        ['€ -10', -10, -10],
        ['10%', 0.1, 0.1],
        ['12,5 %', 0.125, null],
        ['1.5', 1.5, 1.5],
        ['1.234', 1.234, 1.234],
        ['1,234.56', null, 1234.56],
        ['1,234', 1.234, 1234],
        ['$10', 10, 10],
        ['€10', 10, 10],
        ['$1,234.50', null, 1234.5],
        ['42', 42, 42],
        ['1-2-2025', null, null],
        ['06-12345678', null, null],
        ['1,5 kg', null, null],
        ['1.2.3', null, null],
        ['1,2,3', null, null],
        ['€', null, null],
        ['%', null, null],
        ['€10%', null, null],
        ['1.23,4.5', null, null],
        ['abc', null, null],
        ['', null, null],
    ];
    for (const [typed, nl, en] of table) {
        test(`"${typed}" -> nl ${nl}, en ${en}`, () => {
            assert.equal(localeNumber(typed, 'nl'), nl);
            assert.equal(localeNumber(typed, 'en'), en);
        });
    }
    test('sheetLocale knows nl and falls back to en', () => {
        assert.equal(sheetLocale('nl'), 'nl');
        assert.equal(sheetLocale('nl-NL'), 'nl');
        assert.equal(sheetLocale('NL'), 'nl');
        assert.equal(sheetLocale('en'), 'en');
        assert.equal(sheetLocale('de'), 'en');
        assert.equal(sheetLocale(undefined), 'en');
    });
});

describe('a sheet with locale nl', () => {
    const cells = { A1: '1,5', A2: '€ 10', A3: '10%', A4: '1.234,56', A5: '1,5 kg', A6: '=SUM(A1:A5)', A7: '=A1*2' };
    test('sums what a Dutch person typed', () => {
        const out = evaluateSheet(cells, { locale: 'nl' });
        assert.equal(out.A6.value, 1.5 + 10 + 0.1 + 1234.56);
        assert.equal(out.A7.value, 3);
        assert.equal(out.A5.value, '1,5 kg', 'text stays text');
    });
    test('shows the number as it was typed', () => {
        const out = evaluateSheet(cells, { locale: 'nl' });
        assert.equal(out.A1.display, '1,5');
        assert.equal(out.A2.display, '€ 10');
        assert.equal(out.A3.display, '10%');
        assert.equal(typeof out.A1.value, 'number');
    });
    test('the same cells in an en sheet: the Dutch numbers stay text', () => {
        const out = evaluateSheet(cells, {});
        assert.equal(out.A1.value, '1,5');
        assert.equal(out.A6.value, 10 + 0.1, 'only € 10 and 10% count');
    });
    test('a cross-tab reference reads the other tab with the same locale', () => {
        const workbook = { Data: { A1: '2,5' }, Main: { A1: '=Data!A1*2' } };
        assert.equal(evaluateSheet(workbook.Main, { workbook, activeSheet: 'Main', locale: 'nl' }).A1.value, 5);
    });
    test('evaluateCell takes the locale too', () => {
        assert.equal(evaluateCell({ A1: '2,5', B1: '=A1+1' }, 'B1', { locale: 'nl' }).value, 3.5);
    });
});
