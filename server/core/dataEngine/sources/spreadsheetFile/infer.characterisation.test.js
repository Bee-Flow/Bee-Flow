// @typecheck
'use strict';

/**
 * Characterisation (golden) test for the column inference, through its public
 * entry inferColumns: every column (type, key, samples, counts, formats, date
 * spelling), the key candidates and every warning in order, or the error, for
 * sheets that reach every branch: the header shapes (blank, duplicate, missing,
 * not a list), each cell class and its spellings, the share rule at and around
 * the threshold, proven against guessed date spellings, serial numbers in date
 * columns, formula columns, number formats, the sample against the full read,
 * and the uniqueness facts.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/dataEngine/sources/spreadsheetFile/infer.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inferColumns } = require('./infer');

const GOLDEN = path.join(__dirname, 'infer.characterisation.golden.json');

const D = (/** @type {number} */ y, /** @type {number} */ m, /** @type {number} */ d, H = 0, M = 0) => new Date(Date.UTC(y, m - 1, d, H, M));
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
/** `n` rows of one cell: `fill(i)` for the first `k`, `stray` after. */
const share = (/** @type {number} */ n, /** @type {number} */ k, /** @type {(i: number) => unknown} */ fill, /** @type {unknown} */ stray) => Array.from({ length: n }, (_, i) => [i < k ? fill(i) : stray]);

/** @typedef {{ header: unknown, rows: unknown, opts?: Parameters<typeof inferColumns>[2] }} Sheet */
/** @type {Record<string, Sheet>} */
const CASES = {
    invoiceSheet: {
        header: ['Datum', 'Factuurnummer', 'Leverancier', 'Bedrag', 'Betaald', 'Totaal'],
        rows: [[D(2026, 1, 15), 'F-2026-001', 'Acme', 1234.5, true, 2469], [D(2026, 1, 16), 'F-2026-002', 'Beta', 10, false, 20], [D(2026, 1, 17), 'F-2026-003', 'Acme', 5, true, 10]],
        opts: { dateCols: new Set([0]), formulaCols: new Set([5]), numFmts: new Map([[3, '[$€-413] #,##0.00'], [5, '0.0%'], [1, 'General'], [2, '0.00']]) },
    },
    csvStrings: {
        header: ['Naam', 'Datum', 'Bedrag', 'Actief', 'Tijdstip'],
        rows: [['Acme', '15-01-2026', '1.234,56', 'ja', '15-01-2026 09:30'], ['Beta', '16-01-2026', '10,5', 'nee', '16-01-2026 10:00'], ['Gamma', '17-01-2026', '€ 7', 'wel', '2026-01-17 11:15']],
    },
    headerMissing: { header: [], rows: [[1]] },
    headerAllBlank: { header: ['', null, '  '], rows: [[1, 2, 3]] },
    headerNotAList: { header: 'Naam', rows: [['a']] },
    rowsNotAList: { header: ['A', 'B'], rows: null },
    noRows: { header: ['A', 'B'], rows: [] },
    onlyBlankRows: { header: ['A'], rows: [[''], [null], 'not a row', [undefined, '  ']] },
    headerShapes: {
        header: ['Naam', '', 'Naam', null, 'naam', 'Bedrag (€)', 42, D(2026, 3, 1), 'Naam', '  padded  '],
        rows: [['a', 'b', 'c', 'd', 'e', 1, 2, 3, 'f', 'g'], ['h', 'i', 'j', 'k', 'l', 4, 5, 6, 'm', 'n']],
        opts: { formulaCols: new Set([1, 2]) },
    },
    cellClasses: {
        header: ['dates', 'times', 'bools', 'numbers', 'nonFinite', 'iso', 'isoBad', 'isoTime', 'isoTimeBad', 'dayFirstBad', 'dayTime', 'dayTimeBad', 'words', 'marks', 'objects'],
        rows: [
            [D(2026, 1, 15), D(2026, 1, 15, 13, 45), true, 12, Infinity, '2026-01-15', '2026-02-31', '2026-01-15 13:45', '2026-13-01 10:00', '31-02-2026', '15/01/2026 09:30', '15/01/2026 25:00', 'Ja', 'x', { a: 1 }],
            [D(2026, 1, 16), D(2026, 1, 16, 0, 1), false, -3.5, NaN, '2026-01-16', '2026-00-10', '2026-01-16T08:00', '2026-01-40T10:00', '00-01-2026', '16.01.2026 9:05:30', '32/01/2026 10:00', 'ONWAAR', '1', ['a']],
            [D(2026, 1, 17), D(2026, 1, 17, 23, 59), true, 0, -Infinity, ' 2026-01-17 ', '2026-01-17x', '2026-01-17 00:00', 'nope', '15-13-2026', '17-01-2026T07:00', '17-01-2026 7', 'niet', '0', 'text'],
        ],
    },
    thresholdAt95: { header: ['A'], rows: share(100, 95, (i) => i, 'x') },
    thresholdAt94: { header: ['A'], rows: share(100, 94, (i) => i, 'x') },
    thresholdOption: { header: ['A'], rows: share(10, 6, (i) => i, 'x'), opts: { threshold: 0.6 } },
    thresholdOptionMissed: { header: ['A'], rows: share(10, 5, (i) => i, 'x'), opts: { threshold: 0.6 } },
    straysPerType: {
        header: ['bools', 'dates', 'datetimes', 'numbers'],
        rows: Array.from({ length: 40 }, (_, i) => (i < 39 ? [i % 2 ? 'ja' : 'nee', `${pad((i % 28) + 1)}-01-2026`, i ? `${pad((i % 28) + 1)}-01-2026` : '15-01-2026 09:30', `${i},5`] : ['misschien', 'later', 'ooit', 'n.v.t.'])),
    },
    tieBreak: { header: ['numbersAndBools', 'boolsAndDates'], rows: [[1, true], [true, D(2026, 1, 1)]], opts: { threshold: 0.5 } },
    mixedDatesAndTimes: { header: ['When'], rows: [[D(2026, 1, 1)], ['02-01-2026'], [D(2026, 1, 3, 9, 0)], ['2026-01-04']] },
    dateSpelling: {
        header: ['Start', 'Einde', 'Alleen gokken', 'Gemengd', 'Punten'],
        rows: [
            ...Array.from({ length: 11 }, (_, i) => [`${pad(i + 1)}/01/2026`, `01/${pad(i + 1)}/2026`, `${pad(i + 1)}/01/2026`, i < 6 ? `15-${pad(i + 1)}-2026` : `${pad(i + 1)}/15/2026`, `${i + 1}.${i + 1}.2026`]),
            ['01/15/2026', '15/01/2026', '12/01/2026', '2026-01-15', '13.1.2026'],
        ],
    },
    datetimeSpelling: { header: ['Wanneer', 'Guess'], rows: [['03/04/2026 09:30', '03/04/2026 09:30'], ['01/15/2026 10:00', '05/06/2026 10:00']] },
    serialsInDateColumn: {
        header: ['Datum', 'Tijd', 'Geen datumkolom', 'Onleesbaar'],
        rows: [[46037, 46037.5, 46037, -5], [D(2026, 1, 16), 46038.25, 46038, 1e12], [46039, D(2026, 1, 17, 8, 0), 46039, 46039]],
        opts: { dateCols: new Set([0, 1, 3]), numFmts: new Map([[0, 'dd-mm-yyyy'], [2, '€ #,##0']]) },
    },
    sampleAgainstFullRead: {
        header: ['Typed by the sample', 'Unique in the sample only'],
        rows: [[1, 'a'], [2, 'b'], [3, 'c'], ['later text', 'a'], ['more text', ''], [4, 'd']],
        opts: { sampleRows: 3 },
    },
    sampleRowsZero: { header: ['A'], rows: [[1], [2]], opts: { sampleRows: 0 } },
    uniqueness: {
        header: ['text unique', 'number unique', 'with empty', 'duplicates', 'bool', 'date', 'case and space', 'number spellings', 'formula unique'],
        rows: [
            ['a', 1, 'x', 'p', true, D(2026, 1, 1), 'Acme  Inc', '1', 10],
            ['b', 2, '', 'p', false, D(2026, 1, 2), 'Acme Inc', '1,0', 20],
            ['c', 3, 'z', 'q', true, D(2026, 1, 3), ' acme inc ', '2', 30],
        ],
        opts: { formulaCols: new Set([8]) },
    },
    samplesCappedAndDeduped: { header: ['S', 'Dates'], rows: [['a', D(2026, 1, 1)], ['a', D(2026, 1, 1, 8, 30)], ['b', D(2026, 1, 1)], ['c', null], ['d', ''], ['e', D(2026, 1, 2)], ['f', D(2026, 1, 3)], ['g', D(2026, 1, 4)], ['h', D(2026, 1, 5)]] },
    numberFormats: {
        header: ['pct', 'cur', 'dollar', 'general', 'plain', 'dateWithFmt', 'textWithFmt'],
        rows: [[0.1, 1, 2, 3, 4, D(2026, 1, 1), 'a'], [0.2, 5, 6, 7, 8, D(2026, 1, 2), 'b']],
        opts: { numFmts: new Map([[0, '0%'], [1, '€ #,##0.00'], [2, '[$$-409]#,##0'], [3, 'General'], [4, '0.00'], [5, '0%'], [6, '£0']]) },
    },
    raggedRows: { header: ['A', 'B', 'C'], rows: [[1], [2, 'x'], [3, 'y', true], [], [4, 'z', false, 'beyond the header']] },
    blankHeaderKeys: { header: ['', 'col_a', '', 'Col A'], rows: [['a', 'b', 'c', 'd']] },
    serialsTooLargeForADate: { header: ['Datum'], rows: [[1e12], [1e13]], opts: { dateCols: new Set([0]) } },
    minoritySpellingFirst: { header: ['Proven', 'Guessed'], rows: [['01/15/2026', '01-02-2026'], ['15/01/2026', '03/04/2026'], ['16/01/2026', '05/06/2026']] },
    emptyNumberFormat: { header: ['A'], rows: [[1]], opts: { numFmts: new Map([[0, '']]) } },
    textColumnWithDateCells: { header: ['A'], rows: [['15-01-2026'], ['x'], ['16-01-2026'], ['y']], opts: { numFmts: new Map([[0, '0%']]) } },
    headerObjects: { header: [{ col: 2, header: 'Third' }, { header: 'No col' }, { col: 'x', header: 'Bad col' }, { name: 'not a header cell' }], rows: [['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']], opts: { formulaCols: new Set([2]) } },
    headersWithoutLetters: { header: ['€€', '!!!', '123', 'id'], rows: [['a', 'b', 'c', 'd']] },
    straysCountedOverTheSample: { header: ['A'], rows: [...share(20, 19, (i) => i, 'x'), ...share(30, 30, (i) => i + 100, 'x')], opts: { sampleRows: 20 } },
};

/** @param {Sheet} sheet */
function run(sheet) {
    try {
        return inferColumns(/** @type {unknown[]} */ (sheet.header), /** @type {unknown[][]} */ (sheet.rows), sheet.opts);
    } catch (e) {
        const err = /** @type {Error & { status?: number, code?: string }} */ (e);
        return { error: { name: err.name, status: err.status, code: err.code, message: err.message } };
    }
}

test('inferColumns: every sheet gives the recorded columns, key candidates and warnings', () => {
    const actual = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(CASES).map(([name, sheet]) => [name, run(sheet)]))));
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(golden)) assert.deepEqual(actual[name], golden[name], name);
});

test('inferColumns: no options is the same as empty options', () => {
    const { header, rows } = CASES.csvStrings;
    assert.deepEqual(inferColumns(/** @type {unknown[]} */ (header), /** @type {unknown[][]} */ (rows)), inferColumns(/** @type {unknown[]} */ (header), /** @type {unknown[][]} */ (rows), {}));
});
