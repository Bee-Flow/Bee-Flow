/**
 * reading.js: a cells-API matrix becomes the reader contract exactly as a
 * parsed file does; the cells road and the bytes road go through the cache;
 * the write-mode rule; wire ids that carry a OneDrive drive or a Nextcloud
 * path; a content hash that ignores nothing and moves with a cell.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/reading.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const reading = require('./reading');
const cache = require('./cache');

test.beforeEach(() => cache.clear());

test('fromMatrix: header at headerRow, columns to the last non-empty header cell, blank rows dropped and never numbered', () => {
    const matrix = [
        ['ignored', 'row'],
        ['Datum', 'Naam', null, 'Totaal', '', undefined],
        [46000, 'Acme', null, 12, null, 'beyond'],
        [null, null, null, null],
        [46001, 'Bee', null, 13],
    ];
    const r = reading.fromMatrix(matrix, { headerRow: 2, maxRows: 100, maxCols: 100, dateCols: new Set([0, 7]), formulaCols: new Set([3]), sheet: 'Blad1' });
    assert.deepStrictEqual(r.header, ['Datum', 'Naam', null, 'Totaal']);
    assert.deepStrictEqual(r.rows, [[46000, 'Acme', null, 12], [46001, 'Bee', null, 13]]);
    assert.deepStrictEqual(r.rowNumbers, [3, 5]);
    assert.strictEqual(r.lastDataRow, 5);
    assert.deepStrictEqual([...r.dateCols], [0], 'a date column beyond the span is dropped');
    assert.deepStrictEqual([...r.formulaCols], [3]);
    assert.strictEqual(r.truncated, false);
    assert.match(r.warnings[0], /right of the last header column \(4\)/);
});

test('fromMatrix: the cap keeps maxRows and says truncated; a blank header row is header_missing', () => {
    const matrix = [['A', 'B'], [1, 2], [3, 4], [5, 6]];
    const r = reading.fromMatrix(matrix, { headerRow: 1, maxRows: 2, maxCols: 100 });
    assert.strictEqual(r.rows.length, 2);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.lastDataRow, 3);
    assert.throws(() => reading.fromMatrix([['', null], [1, 2]], { headerRow: 1, maxRows: 10, maxCols: 10, sheet: 'X' }), (e) => e.code === 'header_missing' && e.status === 422);
    assert.throws(() => reading.fromMatrix([], { headerRow: 3, maxRows: 10, maxCols: 10 }), (e) => e.code === 'header_missing');
});

test('readSheetOf by cells: one readSheet + one sample per (sheet, headerRow), DATE formats become date columns, cached by marker', async () => {
    const calls = [];
    const api = {
        cells: {
            available: async () => true,
            listSheets: async () => [{ id: 7, name: 'Hidden', index: 0, hidden: true }, { id: 9, name: 'Facturen', index: 1, hidden: false }],
            readSheet: async (file, sheet, opts) => { calls.push(['read', sheet, opts]); return { rows: [['Datum', 'Totaal'], [46000, 1], [46001, 2]], errorCells: 1 }; },
            sample: async (file, sheet, opts) => { calls.push(['sample', sheet, opts]); return { rows: [], numberFormat: new Map([[0, 'DATE']]), formulaCols: new Set([1]) }; },
        },
    };
    const probe = { marker: { version: '5' }, format: 'gsheet', name: 'x', size: null, file: { provider: 'google_drive', fileId: 'g1' } };
    const r = await reading.readSheetOf(api, probe, { sheet: null, headerRow: 1, rowCap: 100, viaCells: true });
    assert.deepStrictEqual(r.header, ['Datum', 'Totaal']);
    assert.deepStrictEqual(r.rows, [[46000, 1], [46001, 2]]);
    assert.deepStrictEqual([...r.dateCols], [0]);
    assert.deepStrictEqual([...r.formulaCols], [1]);
    assert.strictEqual(r.sheet, 'Facturen', 'no sheet named → the first visible tab');
    assert.match(r.warnings[0], /1 cells hold a formula error/);
    assert.deepStrictEqual(calls.map(c => c[0]), ['read', 'sample']);
    assert.deepStrictEqual(calls[0][2], { headerRow: 1, maxRows: 101, maxCols: 100 });
    await reading.readSheetOf(api, probe, { sheet: null, headerRow: 1, rowCap: 100, viaCells: true });
    assert.strictEqual(calls.length, 2, 'the second read of the same marker is a cache hit');
    await reading.readSheetOf(api, { ...probe, marker: { version: '6' } }, { sheet: null, headerRow: 1, rowCap: 100, viaCells: true });
    assert.strictEqual(calls.length, 4, 'a moved marker reads again');
});

test('readSheetOf by bytes: one download per marker, a parse per (sheet, headerRow); a file over the cap is refused before any download', async () => {
    const csv = Buffer.from('Naam;Stad\r\nAcme;Delft\r\nBee;Utrecht\r\n', 'utf8');
    const calls = [];
    const api = { download: async () => { calls.push('download'); return { buffer: csv, marker: { etag: '"1"' } }; } };
    const probe = { marker: { etag: '"1"' }, format: 'csv', name: 'k.csv', size: csv.length, file: { provider: 'nextcloud_files', path: '/k.csv' } };
    const r = await reading.readSheetOf(api, probe, { sheet: null, headerRow: 1, rowCap: 10, viaCells: false });
    assert.deepStrictEqual(r.header, ['Naam', 'Stad']);
    assert.deepStrictEqual(r.rows, [['Acme', 'Delft'], ['Bee', 'Utrecht']]);
    assert.strictEqual(r.csv.delimiter, ';');
    const again = await reading.readSheetOf(api, probe, { sheet: null, headerRow: 2, rowCap: 10, viaCells: false });
    assert.deepStrictEqual(again.header, ['Acme', 'Delft']);
    assert.deepStrictEqual(calls, ['download'], 'another header row is another parse of the same bytes');
    const tabs = await reading.listSheetsOf(api, probe, { viaCells: false });
    assert.deepStrictEqual(tabs, [{ id: null, name: null, index: 0, rows: 3, cols: 2, hidden: false }]);
    assert.deepStrictEqual(calls, ['download']);
    await assert.rejects(
        reading.readSheetOf(api, { ...probe, size: 21 * 1024 * 1024, marker: { etag: '"2"' } }, { sheet: null, headerRow: 1, rowCap: 10, viaCells: false }),
        (e) => e.code === 'spreadsheet_too_large' && e.status === 413,
    );
    assert.deepStrictEqual(calls, ['download'], 'no download for a file the probe already said is too big');
});

test('cellsAvailable: a native Sheet always, an Excel file only when the storage says so, never a csv', async () => {
    assert.strictEqual(await reading.cellsAvailable({}, { format: 'gsheet' }), false, 'no cells on this api at all');
    const api = { cells: { available: async (file) => file.fileId === 'yes' } };
    assert.strictEqual(await reading.cellsAvailable(api, { format: 'gsheet', file: {} }), true);
    assert.strictEqual(await reading.cellsAvailable(api, { format: 'xlsx', file: { fileId: 'yes' } }), true);
    assert.strictEqual(await reading.cellsAvailable(api, { format: 'xlsx', file: { fileId: 'no' } }), false);
    assert.strictEqual(await reading.cellsAvailable(api, { format: 'csv', file: { fileId: 'yes' } }), false);
});

test('writeModeFor: the mechanism by format and storage, none with a reason by format, permission and ownership', () => {
    const m = (f) => reading.writeModeFor(f);
    assert.strictEqual(m({ provider: 'google_drive', format: 'gsheet', owned: true }).mode, 'sheets_api');
    assert.strictEqual(m({ provider: 'google_drive', format: 'xlsx', owned: true }).mode, 'exceljs_put');
    assert.strictEqual(m({ provider: 'onedrive', format: 'xlsx', owned: true, workbook: true }).mode, 'graph_workbook');
    assert.strictEqual(m({ provider: 'onedrive', format: 'xlsx', owned: true, workbook: false }).mode, 'exceljs_put');
    assert.strictEqual(m({ provider: 'nextcloud_files', format: 'xlsx', owned: true }).mode, 'exceljs_put');
    assert.deepStrictEqual(m({ provider: 'nextcloud_files', format: 'csv', owned: true }), { mode: 'csv_put', reason: null, caveats: ['rewrite'], sharedOptIn: false });
    for (const f of ['xlsm', 'xls', 'ods']) assert.deepStrictEqual(m({ provider: 'nextcloud_files', format: f, owned: true }), { mode: 'none', reason: f, caveats: [], sharedOptIn: false });
    assert.strictEqual(m({ provider: 'nextcloud_files', format: 'xlsx', owned: true, writable: false }).reason, 'no_permission');
    assert.strictEqual(m({ provider: 'google_drive', format: 'gsheet', owned: false }).reason, 'not_owned');
    const opted = m({ provider: 'google_drive', format: 'gsheet', owned: false, sharedOptIn: true });
    assert.strictEqual(opted.mode, 'sheets_api');
    assert.strictEqual(opted.sharedOptIn, true);
    assert.strictEqual(m({ provider: 'google_drive', format: 'ods', owned: false, sharedOptIn: true }).reason, 'ods', 'the format refuses before ownership is asked');
});

test('wire ids: a OneDrive item outside the own drive carries its drive; Nextcloud is its path; the ref decodes both', () => {
    assert.strictEqual(reading.wireIdOf({ provider: 'onedrive', fileId: '01A', driveId: 'b!X', owned: false }), 'b!X|01A');
    assert.strictEqual(reading.wireIdOf({ provider: 'onedrive', fileId: '01A', driveId: 'b!X', owned: true }), '01A');
    assert.strictEqual(reading.wireIdOf({ provider: 'nextcloud_files', path: '/Documents/a.csv' }), '/Documents/a.csv');
    assert.strictEqual(reading.wireIdOf({ provider: 'google_drive', fileId: 'g1' }), 'g1');
    assert.deepStrictEqual(reading.fileRefOf('onedrive', { fileId: 'b!X|01A' }), { provider: 'onedrive', fileId: '01A', driveId: 'b!X', path: null, name: null });
    assert.deepStrictEqual(reading.fileRefOf('onedrive', { fileId: '01A', driveId: 'b!Y' }).driveId, 'b!Y');
    assert.deepStrictEqual(reading.fileRefOf('nextcloud_files', { fileId: '/Documents/a.csv' }), { provider: 'nextcloud_files', fileId: null, driveId: null, path: '/Documents/a.csv', name: 'a.csv' });
    assert.throws(() => reading.fileRefOf('nextcloud_files', { fileId: 'Documents/a.csv' }), (e) => e.code === 'spreadsheet_rejected');
    assert.throws(() => reading.fileRefOf('google_drive', {}), (e) => e.code === 'spreadsheet_rejected');
    assert.throws(() => reading.fileRefOf('dropbox', { fileId: 'x' }), (e) => e.code === 'spreadsheet_rejected');
    assert.strictEqual(reading.fileKeyOf('nextcloud_files', { id: null, path: '/a.csv' }), 'nextcloud_files|/a.csv');
    assert.strictEqual(reading.fileKeyOf('google_drive', { id: 'g1' }), reading.fileKeyOf('google_drive', { fileId: 'g1' }));
});

test('contentHashOf moves with any cell and with the header, and dates hash as their ISO form', () => {
    const a = reading.contentHashOf(['A', 'B'], [[1, 'x'], [2, new Date(Date.UTC(2026, 0, 1))]]);
    assert.match(a, /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(reading.contentHashOf(['A', 'B'], [[1, 'x'], [2, new Date(Date.UTC(2026, 0, 1))]]), a);
    assert.notStrictEqual(reading.contentHashOf(['A', 'B'], [[1, 'x'], [2, new Date(Date.UTC(2026, 0, 2))]]), a);
    assert.notStrictEqual(reading.contentHashOf(['A', 'C'], [[1, 'x'], [2, new Date(Date.UTC(2026, 0, 1))]]), a);
    assert.notStrictEqual(reading.contentHashOf(['A', 'B'], [[1, 'x']]), a);
});

test('contentHashOf with row numbers (row identity mode): a blank row deleted above the data moves the hash, identical cells or not', () => {
    const rows = [[1, 'x'], [2, 'y']];
    const gap = reading.contentHashOf(['A', 'B'], rows, [2, 4]);
    const closed = reading.contentHashOf(['A', 'B'], rows, [2, 3]);
    assert.notStrictEqual(gap, closed, 'the same cells at other row numbers are another sheet to a copy keyed by row number');
    assert.strictEqual(reading.contentHashOf(['A', 'B'], rows, [2, 4]), gap);
    assert.notStrictEqual(gap, reading.contentHashOf(['A', 'B'], rows), 'the numbered hash is never the plain one');
    assert.strictEqual(reading.contentHashOf(['A', 'B'], rows, null), reading.contentHashOf(['A', 'B'], rows), 'key mode: null = the plain hash');
});
