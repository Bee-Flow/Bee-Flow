/**
 * Type inference: the 500-row sample, the ≥ 95 % rule, Dutch booleans,
 * day-first dates, decimal commas, blank/duplicate headers, key candidates
 * over the full read, formula columns as derived — and nothing but the five
 * inferable types.
 */
const test = require('node:test');
const assert = require('node:assert');
const { inferColumns, classifyCell, SAMPLE_ROWS } = require('./infer');

const D = (y, m, d, H = 0, M = 0) => new Date(Date.UTC(y, m - 1, d, H, M));

test('classifyCell reads what a cell spells', () => {
    assert.equal(classifyCell(12).cls, 'number');
    assert.equal(classifyCell(true).cls, 'bool');
    assert.equal(classifyCell(D(2026, 1, 15)).cls, 'date');
    assert.equal(classifyCell(D(2026, 1, 15, 13, 45)).cls, 'datetime');
    assert.equal(classifyCell('2026-01-15').cls, 'date');
    assert.equal(classifyCell('2026-01-15 13:45').cls, 'datetime');
    assert.deepEqual(classifyCell('15-01-2026'), { cls: 'date', dateFormat: 'dd-mm-yyyy', guessed: false });
    assert.deepEqual(classifyCell('15/01/2026 09:30'), { cls: 'datetime', dateFormat: 'dd/mm/yyyy', guessed: false });
    assert.deepEqual(classifyCell('03/04/2026'), { cls: 'date', dateFormat: 'dd/mm/yyyy', guessed: true }, 'both halves fit: the spelling is a default');
    assert.equal(classifyCell('31-02-2026').cls, 'text');
    assert.equal(classifyCell('1.234,56').cls, 'number');
    assert.equal(classifyCell('€ 12').cls, 'number');
    assert.equal(classifyCell('0123').cls, 'text');
    for (const w of ['ja', 'Nee', 'waar', 'ONWAAR', 'wel', 'niet', 'yes', 'no', 'y', 'n', 'true', 'false']) assert.equal(classifyCell(w).cls, 'bool', w);
    assert.equal(classifyCell('x').cls, 'text');       // a mark, not a word
    assert.equal(classifyCell('1').cls, 'number');     // a number before a boolean
    assert.equal(classifyCell('Acme').cls, 'text');
    assert.equal(classifyCell(''), null);
});

test('the sandbox invoice sheet infers the five types and finds the key candidate', () => {
    const header = ['Datum', 'Factuurnummer', 'Leverancier', 'Bedrag', 'Betaald', 'Totaal'];
    const rows = [
        [D(2026, 1, 15), 'F-2026-001', 'Acme', 1234.5, true, 2469],
        [D(2026, 1, 16), 'F-2026-002', 'Beta', 10, false, 20],
        [D(2026, 1, 17), 'F-2026-003', 'Acme', 5, true, 10],
    ];
    const { columns, keyCandidates, warnings } = inferColumns(header, rows, { dateCols: new Set([0]), formulaCols: new Set([5]), numFmts: new Map([[3, '[$€-413] #,##0.00']]) });
    assert.deepEqual(columns.map(c => [c.col, c.letter, c.key, c.type, c.unique, c.formula]), [
        [0, 'A', 'datum', 'date', false, false],
        [1, 'B', 'factuurnummer', 'text', true, false],
        [2, 'C', 'leverancier', 'text', false, false],
        [3, 'D', 'bedrag', 'number', true, false],
        [4, 'E', 'betaald', 'bool', false, false],
        [5, 'F', 'totaal', 'number', true, true],
    ]);
    assert.deepEqual(keyCandidates, [1, 3]);                  // a formula column is never a key
    assert.deepEqual(columns[1].samples, ['F-2026-001', 'F-2026-002', 'F-2026-003']);
    assert.deepEqual(columns[0].samples, ['2026-01-15', '2026-01-16', '2026-01-17']);
    assert.equal(columns[0].format, 'date');
    assert.equal(columns[3].format, 'currency');
    assert.equal(columns[3].numFmt, '[$€-413] #,##0.00');
    assert.equal(columns[2].distinct, 2);
    assert.equal(columns[2].nonEmpty, 3);
    assert.deepEqual(warnings, ['"Totaal" holds formulas, so it is read-only here.']);
});

test('a csv of strings: Dutch booleans, dd-mm-yyyy dates and 1.234,56 amounts are typed, with the date spelling kept', () => {
    const header = ['Naam', 'Datum', 'Bedrag', 'Actief', 'Tijdstip'];
    const rows = [
        ['Acme', '15-01-2026', '1.234,56', 'ja', '15-01-2026 09:30'],
        ['Beta', '16-01-2026', '10,5', 'nee', '16-01-2026 10:00'],
        ['Gamma', '17-01-2026', '€ 7', 'wel', '2026-01-17 11:15'],
    ];
    const { columns } = inferColumns(header, rows);
    assert.deepEqual(columns.map(c => c.type), ['text', 'date', 'number', 'bool', 'datetime']);
    assert.equal(columns[1].dateFormat, 'dd-mm-yyyy');
    assert.equal(columns[4].dateFormat, 'dd-mm-yyyy');
    assert.equal(columns[2].dateFormat, undefined);
});

test('a date column\'s spelling is decided by the cells that could not be misread: one 01/15 makes a column of first-of-the-month dates month-first', () => {
    // Eleven ambiguous pairs (both halves ≤ 12), read day-first by default,
    // and ONE cell that can only be month-first: the proven spelling wins.
    const header = ['Start', 'Einde', 'Alleen gokken'];
    const rows = [];
    for (let m = 1; m <= 11; m += 1) rows.push([`${String(m).padStart(2, '0')}/01/2026`, `01/${String(m).padStart(2, '0')}/2026`, `${String(m).padStart(2, '0')}/01/2026`]);
    rows.push(['01/15/2026', '15/01/2026', '12/01/2026']);
    const { columns } = inferColumns(header, rows);
    assert.deepEqual(columns.map(c => c.type), ['date', 'date', 'date']);
    assert.equal(columns[0].dateFormat, 'mm/dd/yyyy', 'the one unambiguous cell decides, not the eleven guesses');
    assert.equal(columns[1].dateFormat, 'dd/mm/yyyy');
    assert.equal(columns[2].dateFormat, 'dd/mm/yyyy', 'nothing proven: the default spelling stands');
    // the spelling is what readCell reads the ambiguous cells by — so 02/01/2026 in "Start" is 1 February
    const cells = require('./cells');
    assert.equal(cells.readCell('02/01/2026', { type: 'date', dateFormat: columns[0].dateFormat }), '2026-02-01');
    assert.equal(cells.readCell('02/01/2026', { type: 'date', dateFormat: columns[1].dateFormat }), '2026-01-02');
    // the same for datetimes
    const dt = inferColumns(['Wanneer'], [['03/04/2026 09:30'], ['01/15/2026 10:00']]);
    assert.equal(dt.columns[0].type, 'datetime');
    assert.equal(dt.columns[0].dateFormat, 'mm/dd/yyyy');
});

test('the 95 % rule: a few strays keep the type (and are warned about), more make it text', () => {
    const header = ['Bedrag', 'Mixed'];
    const rows = [];
    for (let i = 0; i < 100; i += 1) rows.push([i < 96 ? i + 1 : 'n.v.t.', i < 60 ? i : 'tekst']);
    const { columns, warnings } = inferColumns(header, rows);
    assert.equal(columns[0].type, 'number');
    assert.equal(columns[1].type, 'text');
    assert.deepEqual(warnings, ['4 of 100 values in "Bedrag" are not a number and will be empty.']);
    // exactly 95 % still counts; 94 % does not
    const at95 = inferColumns(['A'], Array.from({ length: 100 }, (_, i) => [i < 95 ? i : 'x'])).columns[0].type;
    const at94 = inferColumns(['A'], Array.from({ length: 100 }, (_, i) => [i < 94 ? i : 'x'])).columns[0].type;
    assert.equal(at95, 'number');
    assert.equal(at94, 'text');
});

test('dates and datetimes share one bucket: any clock makes the column a datetime', () => {
    const rows = [[D(2026, 1, 1)], [D(2026, 1, 2)], [D(2026, 1, 3, 9, 0)]];
    assert.equal(inferColumns(['Wanneer'], rows).columns[0].type, 'datetime');
    assert.equal(inferColumns(['Wanneer'], rows.slice(0, 2)).columns[0].type, 'date');
    // a plain serial in a column the reader saw date formats in is a date too
    const mixed = [[D(2026, 1, 1)], [46037]];
    assert.equal(inferColumns(['Wanneer'], mixed, { dateCols: new Set([0]) }).columns[0].type, 'date');
    assert.equal(inferColumns(['Wanneer'], mixed).columns[0].type, 'text');
});

test('only the first 500 non-empty rows are sampled, but uniqueness is judged over the full read', () => {
    const rows = [];
    for (let i = 0; i < SAMPLE_ROWS; i += 1) rows.push([i, `k${i}`]);
    for (let i = 0; i < 100; i += 1) rows.push(['text now', 'k1']);          // beyond the sample: strays + a duplicate key
    const { columns, keyCandidates } = inferColumns(['N', 'K'], rows);
    assert.equal(columns[0].type, 'number');                                 // the sample never saw the strays
    assert.equal(columns[1].unique, false);                                  // the full read did see the duplicate
    assert.equal(columns[0].unique, false);                                  // repeated 'text now' values
    assert.deepEqual(keyCandidates, []);
    assert.equal(columns[1].distinct, SAMPLE_ROWS);
});

test('a column with an empty cell, a duplicate or a non-text/number type is no key candidate', () => {
    const rows = [['a', 1, true, 'x'], ['b', 2, false, null], ['c', 2, true, 'y']];
    const { columns, keyCandidates } = inferColumns(['T', 'N', 'B', 'E'], rows);
    assert.deepEqual(columns.map(c => c.unique), [true, false, false, false]);
    assert.deepEqual(keyCandidates, [0]);
    assert.equal(columns[3].empties, 1);
});

test('blank and duplicate headers are named after the column, and a wholly blank header is a 422', () => {
    const { columns, warnings } = inferColumns(['Naam', '', 'Naam', null], [['a', 1, 'b', 2]]);
    assert.deepEqual(columns.map(c => [c.name, c.key, c.blankHeader, c.duplicateHeader]), [
        ['Naam', 'naam', false, false], ['B', 'col_b', true, false], ['Naam #2', 'naam_2', false, true], ['D', 'col_d', true, false],
    ]);
    assert.equal(columns[1].header, '');
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /Column B has no header/);
    assert.match(warnings[1], /shown as "Naam #2"/);
    for (const header of [[], ['', null, '  ']]) {
        assert.throws(() => inferColumns(header, [[1, 2, 3]]), (e) => {
            assert.equal(e.name, 'SpreadsheetSourceError');
            assert.equal(e.status, 422);
            assert.equal(e.code, 'header_missing');
            assert.equal(e.errorClass, 'datatable_source_rejected');
            return true;
        });
    }
});

test('an empty column and a text column never become select; select is not inferable', () => {
    const rows = Array.from({ length: 50 }, (_, i) => [i % 2 ? 'open' : 'betaald', null]);
    const { columns } = inferColumns(['Status', 'Leeg'], rows);
    assert.equal(columns[0].type, 'text');
    assert.equal(columns[1].type, 'text');
    assert.equal(columns[1].nonEmpty, 0);
    assert.equal(columns[1].unique, false);
    assert.deepEqual(columns[1].samples, []);
});

test('rows that are entirely blank count for nothing', () => {
    const { columns } = inferColumns(['A', 'B'], [[1, 'x'], [null, null], [2, 'y'], [null, '']]);
    assert.equal(columns[0].nonEmpty, 2);
    assert.equal(columns[0].empties, 0);
    assert.equal(columns[0].unique, true);
});
