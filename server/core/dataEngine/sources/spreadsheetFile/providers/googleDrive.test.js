/**
 * Google Drive / Sheets as a mirror storage, against a recording fake of the
 * googleapis clients: the `q` per view (shortcuts and sharedWithMe included),
 * the `version` marker, bytes via alt=media, a native Sheet read with
 * UNFORMATTED_VALUE + SERIAL_NUMBER over a row-capped range, writes as typed
 * ExtendedValues under `fields:'userEnteredValue'`, an append written at
 * the engine's own row (updateCells under `afterRow`; values.append only
 * when the engine does not know it), deleteDimension, and the emulated
 * version guard that refuses before any write.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/providers/googleDrive.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../../testUtils/stubRequire');

const calls = { list: [], get: [], update: [], ssGet: [], valuesGet: [], append: [], batch: [] };
const world = { files: {}, list: { files: [], nextPageToken: null }, media: Buffer.from('a;b\n1;2\n'), version: 7, sheet: {}, grid: [], values: [], appendRange: "'Blad1'!A12:C12", clientOpts: null, savedCalls: 0 };

function fileFixture(id, extra = {}) {
    return { id, name: `${id}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: '1234', modifiedTime: '2026-09-01T10:00:00.000Z', version: String(world.version), md5Checksum: 'md5', webViewLink: `https://drive/${id}`, parents: ['root'], ownedByMe: true, capabilities: { canEdit: true }, trashed: false, ...extra };
}

const fakeDrive = {
    files: {
        list: async (req) => { calls.list.push(req); return { data: world.list }; },
        get: async (req, opts) => {
            calls.get.push({ req, opts });
            if (req.alt === 'media') return { data: world.media };
            const f = world.files[req.fileId];
            if (!f) { const e = new Error('File not found'); e.code = 404; throw e; }
            return { data: { ...f, version: String(world.version) } };
        },
        update: async (req) => { calls.update.push(req); world.version += 1; return { data: fileFixture(req.fileId) }; },
    },
};
const fakeSheets = {
    spreadsheets: {
        get: async (req) => { calls.ssGet.push(req); return { data: req.includeGridData ? { sheets: [{ data: [{ rowData: world.grid }] }] } : world.sheet }; },
        values: {
            get: async (req) => { calls.valuesGet.push(req); return { data: { values: world.values } }; },
            append: async (req) => { calls.append.push(req); world.version += 1; return { data: { updates: { updatedRange: world.appendRange } } }; },
        },
        batchUpdate: async (req) => { calls.batch.push(req); world.version += 1; return { data: {} }; },
    },
};

const restore = installResolveStub({
    '../../../../../integrations/googleClient': {
        createGoogleApiClient: async (session, opts) => { world.clientOpts = opts; return { drive: fakeDrive, sheets: fakeSheets }; },
    },
});
const googleDrive = require('./googleDrive');
test.after(() => restore());
test.beforeEach(() => {
    for (const k of Object.keys(calls)) calls[k].length = 0;
    Object.assign(world, { files: { f1: fileFixture('f1'), g: fileFixture('g', { name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', size: undefined }) }, list: { files: [], nextPageToken: null }, media: Buffer.from('a;b\n1;2\n'), version: 7, sheet: {}, grid: [], values: [], appendRange: "'Blad1'!A12:C12", clientOpts: null, savedCalls: 0 });
});

const cred = { oauthProvider: 'google', accessToken: 'at', save: async () => { world.savedCalls += 1; } };
const api = () => googleDrive.forLinker(cred, { userId: 'u1', orgId: 'org_1' });
const SPREAD_MIME = "mimeType='application/vnd.google-apps.spreadsheet'";

test('the module shape and the client it builds (Drive v3 + Sheets v4 on one OAuth2, rotated tokens saved through the shim)', async () => {
    assert.equal(googleDrive.provider, 'google_drive');
    assert.equal(googleDrive.oauthProvider, 'google');
    assert.deepEqual(googleDrive.integrationAppIds, ['google-drive']);
    await api().probe({ fileId: 'f1' });
    assert.equal(world.clientOpts.api, 'drive');
    assert.equal(world.clientOpts.version, 'v3');
    assert.deepEqual(world.clientOpts.extraApis, [{ api: 'sheets', version: 'v4' }]);
    world.clientOpts.onSaved({});
    await new Promise((r) => setImmediate(r));
    assert.equal(world.savedCalls, 1, 'onSaved is the shim\'s save()');
});

test('list: q per view — mine (parent), shared (sharedWithMe), search (name contains, files only), recent', async () => {
    const a = api();
    await a.list({ view: 'mine' });
    assert.match(calls.list[0].q, /^'root' in parents and trashed=false and \(mimeType='application\/vnd\.google-apps\.folder' or \(/);
    assert.ok(calls.list[0].q.includes(SPREAD_MIME) && calls.list[0].q.includes("mimeType='text/csv'") && calls.list[0].q.includes("mimeType='application/vnd.google-apps.shortcut'"));
    assert.equal(calls.list[0].supportsAllDrives, true);
    assert.equal(calls.list[0].includeItemsFromAllDrives, true);
    assert.equal(calls.list[0].orderBy, 'folder,name');
    assert.match(calls.list[0].fields, /ownedByMe/);
    assert.match(calls.list[0].fields, /shortcutDetails/);
    await a.list({ view: 'mine', parentId: "it's" });
    assert.match(calls.list[1].q, /^'it\\'s' in parents/);
    await a.list({ view: 'shared' });
    assert.match(calls.list[2].q, /^sharedWithMe=true and trashed=false and \(mimeType='application\/vnd\.google-apps\.folder' or/);
    await a.list({ view: 'shared', parentId: 'sharedFolder' });
    assert.match(calls.list[3].q, /^'sharedFolder' in parents/, 'inside a shared folder the listing is a parent listing');
    await a.list({ view: 'search', q: "Q3 'report'" });
    assert.match(calls.list[4].q, /^name contains 'Q3 \\'report\\'' and trashed=false and \(mimeType=/);
    assert.ok(!calls.list[4].q.includes('google-apps.folder'), 'search lists files only');
    await a.list({ view: 'recent', pageToken: 'p2' });
    assert.equal(calls.list[5].orderBy, 'modifiedTime desc');
    assert.equal(calls.list[5].pageToken, 'p2');
    const empty = await a.list({ view: 'search', q: '  ' });
    assert.deepEqual(empty, { items: [], nextPageToken: null });
});

test('list: FileRefs — folders kept, non-spreadsheets dropped, shortcuts resolved to their target, owned from ownedByMe', async () => {
    world.list = {
        nextPageToken: 'next',
        files: [
            { id: 'd1', name: 'Docs', mimeType: 'application/vnd.google-apps.folder', ownedByMe: true },
            { id: 'g1', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-09-02T00:00:00Z', webViewLink: 'https://x/g1', ownedByMe: false, parents: ['d1'] },
            { id: 'doc', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
            { id: 's1', name: 'Link to sheet', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'g2', targetMimeType: 'application/vnd.google-apps.spreadsheet' } },
            { id: 's2', name: 'Link to doc', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'doc2', targetMimeType: 'application/vnd.google-apps.document' } },
            { id: 'c1', name: 'klanten.csv', mimeType: 'text/plain', size: '10', capabilities: { canEdit: false } },
        ],
    };
    const { items, nextPageToken } = await api().list({ view: 'mine' });
    assert.equal(nextPageToken, 'next');
    assert.deepEqual(items.map((i) => [i.fileId, i.isFolder, i.format, i.owned]), [
        ['d1', true, null, true], ['g1', false, 'gsheet', false], ['g2', false, 'gsheet', false], ['c1', false, 'csv', false],
    ]);
    assert.equal(items[1].parentId, 'd1');
    assert.equal(items[1].webUrl, 'https://x/g1');
    assert.equal(items[2].shortcut, true);
    assert.equal(items[2].shortcutId, 's1');
    assert.equal(items[3].writable, false);
    assert.equal(items[3].size, 10);
    assert.equal(items[0].provider, 'google_drive');
});

test('probe: the marker is the Drive version (+ modifiedTime/md5/size), fields include ownership and capabilities, trashed → 404', async () => {
    const p = await api().probe({ fileId: 'f1' });
    assert.deepEqual(p.marker, { version: '7', modifiedTime: '2026-09-01T10:00:00.000Z', md5Checksum: 'md5', size: 1234 });
    assert.equal(p.format, 'xlsx');
    assert.equal(p.owned, true);
    assert.equal(p.writable, true);
    assert.equal(p.webUrl, 'https://drive/f1');
    assert.equal(p.file.fileId, 'f1');
    assert.match(calls.get[0].req.fields, /version/);
    assert.match(calls.get[0].req.fields, /md5Checksum/);
    assert.match(calls.get[0].req.fields, /ownedByMe/);
    assert.match(calls.get[0].req.fields, /capabilities\(canEdit\)/);
    assert.match(calls.get[0].req.fields, /trashed/);
    assert.equal(calls.get[0].req.supportsAllDrives, true);
    assert.equal(googleDrive.markerEquals(p.marker, { version: '7', modifiedTime: 'other' }), true, 'version alone decides');
    assert.equal(googleDrive.markerEquals(p.marker, { version: '8' }), false);
    world.files.f1.trashed = true;
    await assert.rejects(() => api().probe({ fileId: 'f1' }), (e) => e.code === 'spreadsheet_not_found' && e.status === 404);
    await assert.rejects(() => api().probe({ fileId: 'nope' }), (e) => e.code === 'spreadsheet_not_found');
});

test('download: alt=media as an arraybuffer, the marker probed BEFORE the bytes, the size cap before the GET', async () => {
    const { buffer, marker } = await api().download({ fileId: 'f1' }, { maxBytes: 20e6 });
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.toString(), 'a;b\n1;2\n');
    assert.equal(marker.version, '7');
    const media = calls.get.find((c) => c.req.alt === 'media');
    assert.deepEqual(media.opts, { responseType: 'arraybuffer' });
    assert.equal(media.req.supportsAllDrives, true);
    calls.get.length = 0;
    await assert.rejects(() => api().download({ fileId: 'f1' }, { maxBytes: 100 }), (e) => e.code === 'spreadsheet_too_large' && e.status === 413);
    assert.equal(calls.get.filter((c) => c.req.alt === 'media').length, 0, 'no bytes fetched past the cap');
    await assert.rejects(() => api().download({ fileId: 'g' }), (e) => e.code === 'spreadsheet_rejected', 'a native Sheet has no bytes');
});

test('upload: files.update with media, emulated version guard first', async () => {
    const r = await api().upload({ fileId: 'f1' }, Buffer.from('x'), { ifMatch: { version: '7' }, contentType: 'text/csv' });
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].fileId, 'f1');
    assert.equal(calls.update[0].media.mimeType, 'text/csv');
    assert.equal(calls.update[0].supportsAllDrives, true);
    assert.match(calls.update[0].fields, /version/);
    assert.equal(r.marker.version, '8');
    calls.update.length = 0;
    await assert.rejects(() => api().upload({ fileId: 'f1' }, Buffer.from('x'), { ifMatch: { version: '7' } }), (e) => e.code === 'spreadsheet_conflict' && e.status === 409);
    assert.equal(calls.update.length, 0, 'a moved version writes nothing');
});

test('cells.listSheets + available: tabs by gid, only for native Sheets', async () => {
    world.sheet = { sheets: [{ properties: { sheetId: 0, title: 'Blad1', index: 0, gridProperties: { rowCount: 1000, columnCount: 26 } } }, { properties: { sheetId: 99, title: 'Hidden', index: 1, hidden: true } }] };
    const a = api();
    assert.equal(await a.cells.available({ fileId: 'g', format: 'gsheet' }), true);
    assert.equal(await a.cells.available({ fileId: 'f1', format: 'xlsx' }), false);
    const tabs = await a.cells.listSheets({ fileId: 'g' });
    assert.deepEqual(tabs, [
        { id: 0, name: 'Blad1', index: 0, rowCount: 1000, colCount: 26, hidden: false },
        { id: 99, name: 'Hidden', index: 1, rowCount: null, colCount: null, hidden: true },
    ]);
    assert.match(calls.ssGet[0].fields, /sheetId,title,index,hidden,gridProperties/);
});

test('cells.sample: includeGridData over 1:<headerRow+500> with the number-format + formula field mask', async () => {
    world.grid = [
        { values: [{ effectiveValue: { stringValue: 'Datum' } }, { effectiveValue: { stringValue: 'Bedrag' } }, { effectiveValue: { stringValue: 'Totaal' } }] },
        { values: [{ effectiveValue: { numberValue: 46000 }, effectiveFormat: { numberFormat: { type: 'DATE' } } }, { effectiveValue: { numberValue: 12.5 } }, { effectiveValue: { numberValue: 12.5 }, userEnteredValue: { formulaValue: '=B2' } }] },
        { values: [{ effectiveValue: { numberValue: 46001 }, effectiveFormat: { numberFormat: { type: 'DATE' } } }, { effectiveValue: { errorValue: { type: 'N/A' } } }, { effectiveValue: { boolValue: true } }] },
    ];
    const s = await api().cells.sample({ fileId: 'g' }, { id: 0, name: "O'Brien" }, { headerRow: 1, rows: 500 });
    assert.deepEqual(calls.ssGet[0].ranges, ["'O''Brien'!1:501"]);
    assert.equal(calls.ssGet[0].includeGridData, true);
    assert.equal(calls.ssGet[0].fields, 'sheets.data.rowData.values(effectiveValue,effectiveFormat.numberFormat.type,userEnteredValue.formulaValue)');
    assert.deepEqual(s.rows, [['Datum', 'Bedrag', 'Totaal'], [46000, 12.5, 12.5], [46001, null, true]]);
    assert.equal(s.numberFormat.get(0), 'DATE');
    assert.equal(s.numberFormat.has(1), false);
    assert.deepEqual([...s.formulaCols], [2]);
});

test('cells.readSheet: values.get UNFORMATTED_VALUE + SERIAL_NUMBER over the row-capped range; error strings → null', async () => {
    world.values = [['Datum', 'Bedrag', 'Ok'], [46000, 12.5, true], ['#N/A', '0123', false]];
    const r = await api().cells.readSheet({ fileId: 'g' }, 'Blad1', { headerRow: 1, maxRows: 10001, maxCols: 2 });
    assert.deepEqual(calls.valuesGet[0], { spreadsheetId: 'g', range: "'Blad1'!1:10002", valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
    assert.deepEqual(r.rows, [['Datum', 'Bedrag'], [46000, 12.5], [null, '0123']]);
    assert.equal(r.errorCells, 1);
    world.values = [[5, 'x']];
    assert.deepEqual(await api().cells.readRow({ fileId: 'g' }, 'Blad1', 7), [5, 'x']);
    assert.equal(calls.valuesGet[1].range, "'Blad1'!7:7");
});

test('cells.updateCells: typed ExtendedValue per cell with fields userEnteredValue; text never becomes a formula; empty clears', async () => {
    const r = await api().cells.updateCells({ fileId: 'g' }, { id: 5, name: 'Blad1' }, 7, [
        { col: 2, value: '=SUM(A1)', type: 'text' },
        { col: 0, value: 46000, type: 'date' },
        { col: 1, value: '12.5', type: 'number' },
        { col: 3, value: true, type: 'bool' },
        { col: 4, value: null, type: 'text' },
    ], { ifMatch: { version: '7' } });
    const reqs = calls.batch[0].requestBody.requests;
    assert.equal(calls.batch[0].spreadsheetId, 'g');
    assert.deepEqual(reqs[0].updateCells, { start: { sheetId: 5, rowIndex: 6, columnIndex: 2 }, rows: [{ values: [{ userEnteredValue: { stringValue: '=SUM(A1)' } }] }], fields: 'userEnteredValue' });
    assert.deepEqual(reqs[1].updateCells.rows[0].values[0].userEnteredValue, { numberValue: 46000 });
    assert.deepEqual(reqs[2].updateCells.rows[0].values[0].userEnteredValue, { numberValue: 12.5 });
    assert.deepEqual(reqs[3].updateCells.rows[0].values[0].userEnteredValue, { boolValue: true });
    assert.deepEqual(reqs[4].updateCells.rows[0].values[0].userEnteredValue, {});
    assert.equal(r.marker.version, '8', 're-probed after the write');
    assert.equal(calls.ssGet.length, 0, 'a sheet given with its gid needs no lookup');
});

test('cells.updateCells: a moved version refuses with spreadsheet_conflict and no write call', async () => {
    calls.batch.length = 0;
    await assert.rejects(() => api().cells.updateCells({ fileId: 'g' }, { id: 5, name: 'Blad1' }, 7, [{ col: 0, value: 'x', type: 'text' }], { ifMatch: { version: '6' } }),
        (e) => e.code === 'spreadsheet_conflict' && e.status === 409);
    assert.equal(calls.batch.length, 0);
});

test('cells.appendRow with afterRow (the engine\'s last data row): updateCells at that row — never values.append, which would land in the first gap and shift the rows under it', async () => {
    world.sheet = { sheets: [{ properties: { sheetId: 5, title: 'Blad1', index: 0, gridProperties: { rowCount: 100, columnCount: 4 } } }] };
    world.values = [];                                   // row 13 is blank
    const r = await api().cells.appendRow({ fileId: 'g' }, 'Blad1', [
        { col: 0, value: 46000, type: 'date' }, { col: 1, value: 'Acme', type: 'text' }, { col: 3, value: null, type: 'number' },
    ], { ifMatch: { version: '7' }, afterRow: 12 });
    assert.equal(r.rowNumber, 13);
    assert.deepEqual(calls.append, [], 'no values.append');
    assert.deepEqual(calls.valuesGet.map((q) => q.range), ["'Blad1'!13:13"], 'the target row is read first');
    const reqs = calls.batch[0].requestBody.requests;
    assert.deepEqual(reqs, [
        { updateCells: { start: { sheetId: 5, rowIndex: 12, columnIndex: 0 }, rows: [{ values: [{ userEnteredValue: { numberValue: 46000 } }] }], fields: 'userEnteredValue' } },
        { updateCells: { start: { sheetId: 5, rowIndex: 12, columnIndex: 1 }, rows: [{ values: [{ userEnteredValue: { stringValue: 'Acme' } }] }], fields: 'userEnteredValue' } },
        { updateCells: { start: { sheetId: 5, rowIndex: 12, columnIndex: 3 }, rows: [{ values: [{ userEnteredValue: {} }] }], fields: 'userEnteredValue' } },
    ], 'written where it belongs, no dimension change');
    assert.equal(calls.batch[1].requestBody.requests[0].repeatCell.range.startRowIndex, 12, 'the date format on that row');
    assert.ok(r.marker.version > '7');

    // the grid ends above the target row: it is grown first (a write past rowCount is a 400)
    for (const k of Object.keys(calls)) calls[k].length = 0;
    world.version = 7;
    const g = await api().cells.appendRow({ fileId: 'g' }, 'Blad1', [{ col: 0, value: 'x', type: 'text' }], { ifMatch: { version: '7' }, afterRow: 100 });
    assert.equal(g.rowNumber, 101);
    assert.deepEqual(calls.valuesGet, [], 'a row beyond the grid is blank by definition');
    assert.deepEqual(calls.batch[0].requestBody.requests, [
        { appendDimension: { sheetId: 5, dimension: 'ROWS', length: 1 } },
        { updateCells: { start: { sheetId: 5, rowIndex: 100, columnIndex: 0 }, rows: [{ values: [{ userEnteredValue: { stringValue: 'x' } }] }], fields: 'userEnteredValue' } },
    ]);

    // the target row holds something after all: a row is INSERTED there, nothing overwritten
    for (const k of Object.keys(calls)) calls[k].length = 0;
    world.version = 7;
    world.values = [['someone', 'typed', 'here']];
    const i = await api().cells.appendRow({ fileId: 'g' }, 'Blad1', [{ col: 0, value: 'x', type: 'text' }], { ifMatch: { version: '7' }, afterRow: 12 });
    assert.equal(i.rowNumber, 13);
    assert.deepEqual(calls.batch[0].requestBody.requests[0], { insertDimension: { range: { sheetId: 5, dimension: 'ROWS', startIndex: 12, endIndex: 13 }, inheritFromBefore: true } });
    assert.equal(calls.batch[0].requestBody.requests[1].updateCells.start.rowIndex, 12);
    world.values = [];
});

test('cells.appendRow without afterRow (a truncated read): values.append RAW INSERT_ROWS, the row number from updatedRange, DATE/DATE_TIME formats for date columns', async () => {
    world.sheet = { sheets: [{ properties: { sheetId: 5, title: 'Blad1', index: 0 } }] };
    const r = await api().cells.appendRow({ fileId: 'g' }, 'Blad1', [
        { col: 0, value: 46000, type: 'date' }, { col: 1, value: 'Acme', type: 'text' }, { col: 2, value: 46000.5, type: 'datetime' }, { col: 3, value: null, type: 'number' },
    ], { ifMatch: { version: '7' } });
    assert.equal(r.rowNumber, 12);
    assert.deepEqual(calls.append[0], { spreadsheetId: 'g', range: "'Blad1'!A1", valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [[46000, 'Acme', 46000.5, null]] } });
    const fmt = calls.batch[0].requestBody.requests;
    assert.equal(fmt.length, 2);
    assert.deepEqual(fmt[0].repeatCell, {
        range: { sheetId: 5, startRowIndex: 11, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
        fields: 'userEnteredFormat.numberFormat',
    });
    assert.equal(fmt[1].repeatCell.cell.userEnteredFormat.numberFormat.type, 'DATE_TIME');
    assert.equal(fmt[1].repeatCell.range.startColumnIndex, 2);
    assert.ok(r.marker.version > '7');
});

test('cells.deleteRow: deleteDimension on the gid; a missing tab is sheet_missing', async () => {
    world.sheet = { sheets: [{ properties: { sheetId: 5, title: 'Blad1', index: 0 } }] };
    await api().cells.deleteRow({ fileId: 'g' }, 'Blad1', 9);
    assert.deepEqual(calls.batch[0].requestBody.requests, [{ deleteDimension: { range: { sheetId: 5, dimension: 'ROWS', startIndex: 8, endIndex: 9 } } }]);
    await assert.rejects(() => api().cells.deleteRow({ fileId: 'g' }, 'Gone', 9), (e) => e.code === 'sheet_missing' && e.status === 404 && e.ref.sheet === 'Gone');
});

test('helpers: column letters and the updatedRange parser', () => {
    assert.equal(googleDrive.colLetter(0), 'A');
    assert.equal(googleDrive.colLetter(25), 'Z');
    assert.equal(googleDrive.colLetter(26), 'AA');
    assert.equal(googleDrive.rowNumberOfRange("'My Sheet'!A12:F12"), 12);
    assert.equal(googleDrive.rowNumberOfRange('Blad1!C3'), 3);
    assert.equal(googleDrive.rowNumberOfRange(null), null);
});
