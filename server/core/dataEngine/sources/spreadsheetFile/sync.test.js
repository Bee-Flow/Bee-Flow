/**
 * The refresh pass of a spreadsheet mirror, with the storage and the stores
 * stubbed: an unmoved marker ends the pass after one probe (no download, no
 * snapshot, no batch); a moved marker with the same content ends it after
 * the download — unless rows are identified by number and a blank row went,
 * which moves every id under it; a stale mark forces the read; rows land
 * under key ids (a number key under the number, whatever the spelling), a
 * moved key column keeps them, a vanished one falls back to row numbers;
 * new columns are inferred once and said so; a stray cell is counted; a
 * native Sheet reads by cells; the reader's cap says truncated.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/sync.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');
const columns = require('./columns');
const cache = require('./cache');

// ── the world ──────────────────────────────────────────────────────────────
const SCOPE = { kind: 'org', id: 'org_1' };
const HEADER = ['Factuurnummer', 'Leverancier', 'Totaal'];
const first = columns.fieldsFromSheet(HEADER.map((h, col) => ({ col, header: h, type: col === 2 ? 'number' : 'text' })), { keyCol: 0 });
const KEY_ID = first.keyFieldId;
const META = { id: 'tbl_fac', key: 'facturen', fields: first.fields };

function mirror(over = {}) {
    return {
        id: 'tbl_fac', key: 'facturen', name: 'Facturen', scope: SCOPE, scopeKind: 'org', organizationId: 'org_1',
        managedKind: 'spreadsheet_file', rowScope: 'all', rowCount: 0, isPublished: false, sharedGroups: [], writeMode: 'grants',
        source: {
            kind: 'spreadsheet_file', provider: 'google_drive', format: 'csv',
            file: { id: 'f1', driveId: null, path: null, name: 'facturen.csv', webUrl: null },
            sheet: { id: null, name: null, index: 0 }, headerRow: 1,
            identity: { mode: 'key', keyFieldId: KEY_ID }, csv: null, owned: true,
            write: { mode: 'csv_put', reason: null, caveats: ['rewrite'], sharedOptIn: false },
            linkedByUserId: 'user_1', schedule: { everyMinutes: 1, live: true }, refreshOnView: true, rowCap: 10000,
            columnMap: first.columnMap, relations: [],
        },
        syncState: null,
        ...over,
    };
}

const world = { existingIds: [], batches: [], queries: [], finished: [], rowCounts: [], sources: [], calls: [], file: null, meta: META, api: null };
function csv(lines) { return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'); }
function reset() {
    cache.clear();
    world.claimRow = mirror();
    Object.assign(world, { existingIds: [], batches: [], queries: [], finished: [], rowCounts: [], sources: [], calls: [], meta: META, api });
    world.file = { version: 1, buffer: csv(['Factuurnummer;Leverancier;Totaal', 'F-1;Acme;10', 'F-2;Bee;20']) };
}
const api = {
    probe: async () => { world.calls.push('probe'); return { marker: { version: String(world.file.version) }, name: 'facturen.csv', size: world.file.buffer.length, format: 'csv', path: null, webUrl: null, owned: true, writable: true, file: { provider: 'google_drive', fileId: 'f1', format: 'csv' } }; },
    download: async () => { world.calls.push('download'); return { buffer: world.file.buffer, marker: { version: String(world.file.version) } }; },
    markerEquals: (a, b) => !!a && !!b && a.version != null && String(a.version) === String(b.version),
};

const datatableStore = {
    claimSourceSync: async (id) => ({ ...world.claimRow, id }),
    finishSourceSync: async (id, patch) => { world.finished.push(JSON.parse(JSON.stringify(patch))); return mirror({ syncState: patch }); },
    getTableMeta: async () => world.meta,
    listSourceMirrorsInScope: async () => [world.claimRow],
    setSource: async (id, scope, source) => { world.sources.push(source); world.claimRow = { ...world.claimRow, source }; return world.claimRow; },
    setRowCount: async (id, scope, n) => { world.rowCounts.push(n); },
    getDatatable: async () => world.claimRow,
    markSourceStale: async () => {},
};
const datatableDbStore = {
    scopeKey: () => 'org:org_1',
    query: async (a, b, sql) => {
        world.queries.push(sql);
        if (/^SELECT "id" FROM/.test(sql)) return { rows: world.existingIds.map(id => ({ id })), truncated: false };
        return { rows: [] };
    },
    batch: async (a, b, stmts) => { world.batches.push(stmts); return stmts.map(() => ({ changes: 1 })); },
};
const restore = installResolveStub({
    '../../../../stores/datatableStore': datatableStore,
    '../../../../stores/datatableDbStore': datatableDbStore,
    '../../../../auth/datatableAccess': { synthesizeAccess: () => ({ default: 'app' }), gradeAtLeast: () => true },
    '../../datatableLimits': { assertDatatableQuota: async () => ({}) },
    // The api is read from the world at call time: a test swaps in a
    // cells-only storage or a refusing one without re-stubbing.
    './linkerAuth': { resolveLinker: async () => ({ api: world.api, userId: 'user_1', session: {} }), forget: () => {} },
    './schema': { reconcileMirrorSchema: async () => ({ modelVersion: 2 }) },
    './relations': { buildRelationIndexes: async () => ({ relationIndexes: new Map(), labelIndexes: new Map(), warnings: [] }) },
});
const sync = require('./sync');
test.after(() => restore());
test.beforeEach(reset);
function run(m, opts) { world.claimRow = m; return sync.syncRows(m, opts); }
const upserts = () => world.batches.flat().filter(s => /ON CONFLICT/.test(s.sql));
const idsWritten = () => upserts().map(s => s.params[0]);

test('an unmoved marker ends the pass after one probe: no download, no snapshot, no batch, data_version untouched', async () => {
    const m = mirror({ syncState: { status: 'ok', lastSuccessAt: '2026-09-13T09:00:00.000Z', marker: { version: '1' }, contentHash: 'sha256:old' } });
    const out = await run(m, { reason: 'live' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    assert.strictEqual(out.unchanged, true);
    assert.deepStrictEqual(world.calls, ['probe']);
    assert.strictEqual(world.queries.some(q => /^SELECT "id" FROM/.test(q)), false);
    assert.deepStrictEqual(world.batches, []);
    assert.deepStrictEqual(world.rowCounts, []);
    const fin = world.finished[0];
    assert.strictEqual(fin.skipped, 'unchanged');
    assert.deepStrictEqual(fin.marker, { version: '1' });
    assert.ok(fin.lastProbeAt);
    assert.strictEqual(fin.lastFetchAt, undefined);
});

test('a moved marker with the same content downloads once and still ends unchanged, recording the new marker', async () => {
    const same = require('./reading').contentHashOf(HEADER, [['F-1', 'Acme', '10'], ['F-2', 'Bee', '20']]);
    world.file.version = 2;
    const m = mirror({ syncState: { status: 'ok', lastSuccessAt: '2026-09-13T09:00:00.000Z', marker: { version: '1' }, contentHash: same } });
    const out = await run(m, { reason: 'schedule' });
    assert.strictEqual(out.unchanged, true);
    assert.deepStrictEqual(world.calls, ['probe', 'download']);
    assert.deepStrictEqual(world.batches, []);
    assert.deepStrictEqual(world.finished[0].marker, { version: '2' });
    assert.strictEqual(world.finished[0].contentHash, same);
});

test('row mode: a blank row deleted inside the data (every cell identical, every row number under it moved) is NOT unchanged — the copy is renumbered', async () => {
    const reading = require('./reading');
    const ROWS = [['F-1', 'Acme', '10'], ['F-2', 'Bee', '20']];
    // the previous pass read the sheet with a blank row 3: r2 and r4
    const before = reading.contentHashOf(HEADER, ROWS, [2, 4]);
    world.existingIds = ['r2', 'r4'];
    world.file = { version: 2, buffer: csv(['Factuurnummer;Leverancier;Totaal', 'F-1;Acme;10', 'F-2;Bee;20']) };
    const m = mirror({ syncState: { status: 'ok', lastSuccessAt: '2026-09-13T09:00:00.000Z', marker: { version: '1' }, contentHash: before } });
    m.source.identity = { mode: 'row' };
    const out = await run(m, { reason: 'schedule' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    assert.strictEqual(out.unchanged, undefined, 'the same cells at other row numbers are another sheet to a copy keyed by row number');
    assert.deepStrictEqual(world.calls, ['probe', 'download']);
    assert.deepStrictEqual(idsWritten(), ['r2', 'r3']);
    assert.deepStrictEqual(world.batches.flat().filter(s => /^DELETE/.test(s.sql)).map(s => s.params[0]), ['r4'], 'r4 no longer names a sheet row');
    assert.strictEqual(world.finished[0].identity.mode, 'row');
    assert.strictEqual(world.finished[0].contentHash, reading.contentHashOf(HEADER, ROWS, [2, 3]), 'the hash the next write must reproduce (writeThrough.record)');
    // the same file read again: unchanged, at the numbered hash
    reset();
    world.file = { version: 3, buffer: csv(['Factuurnummer;Leverancier;Totaal', 'F-1;Acme;10', 'F-2;Bee;20']) };
    const again = mirror({ syncState: { status: 'ok', lastSuccessAt: '2026-09-13T09:00:00.000Z', marker: { version: '2' }, contentHash: reading.contentHashOf(HEADER, ROWS, [2, 3]) } });
    again.source.identity = { mode: 'row' };
    const o2 = await run(again, { reason: 'schedule' });
    assert.strictEqual(o2.unchanged, true);

    // key mode: the copy stores no row number, so the very same shift IS nothing
    reset();
    world.existingIds = ['F-1', 'F-2'];
    world.file = { version: 2, buffer: csv(['Factuurnummer;Leverancier;Totaal', 'F-1;Acme;10', 'F-2;Bee;20']) };
    const k = await run(mirror({ syncState: { status: 'ok', lastSuccessAt: '2026-09-13T09:00:00.000Z', marker: { version: '1' }, contentHash: reading.contentHashOf(HEADER, ROWS) } }), { reason: 'schedule' });
    assert.strictEqual(k.unchanged, true);
    assert.deepStrictEqual(world.batches, []);
});

test('a stale mark forces the read even on an unmoved marker; rows land under their key ids with the state patch', async () => {
    const m = mirror({ syncState: { status: 'ok', lastSuccessAt: '2026-09-13T09:00:00.000Z', marker: { version: '1' }, staleReason: 'event' } });
    const out = await run(m, { reason: 'event' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    assert.strictEqual(out.unchanged, undefined);
    assert.deepStrictEqual(world.calls, ['probe', 'download']);
    assert.deepStrictEqual(idsWritten(), ['F-1', 'F-2']);
    const u = upserts()[0];
    assert.deepStrictEqual(u.params.slice(5, 8), ['F-1', 'Acme', 10], 'the read codec typed Totaal as a number');
    assert.deepStrictEqual(world.rowCounts, [2]);
    const fin = world.finished[0];
    assert.strictEqual(fin.staleReason, null);
    assert.deepStrictEqual(fin.identity, { mode: 'key', missing: 0, duplicate: 0 });
    assert.deepStrictEqual(fin.coercion, {});
    assert.deepStrictEqual(fin.file, { name: 'facturen.csv' });
    assert.ok(fin.lastFetchAt);
    assert.strictEqual(fin.csv.delimiter, ';');
    assert.match(fin.contentHash, /^sha256:/);
});

test('a blank key, a duplicate key and a stray cell are skipped and counted, never written', async () => {
    world.file.buffer = csv(['Factuurnummer;Leverancier;Totaal', 'F-1;Acme;10', ';Nobody;5', 'F-1;Again;7', 'F-3;Cee;n.v.t.']);
    const out = await run(mirror(), { reason: 'link' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    assert.deepStrictEqual(idsWritten(), ['F-1', 'F-3']);
    assert.strictEqual(out.skippedRows, 2);
    const fin = world.finished[0];
    assert.deepStrictEqual(fin.identity, { mode: 'key', missing: 1, duplicate: 1 });
    assert.deepStrictEqual(fin.coercion, { totaal: 1 });
    assert.ok(out.warnings.some(w => /1 rows share a key/.test(w)), JSON.stringify(out.warnings));
    assert.ok(out.warnings.some(w => /1 rows have no value in the key column/.test(w)));
    const cee = upserts()[1];
    assert.strictEqual(cee.params[7], null, 'n.v.t. is not a number → NULL');
});

test('a moved key column keeps the ids; a vanished one falls back to row numbers and says so', async () => {
    world.file.buffer = csv(['Leverancier;Totaal;Factuurnummer', 'Acme;10;F-1', 'Bee;20;F-2']);
    let out = await run(mirror(), { reason: 'manual' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    assert.deepStrictEqual(idsWritten(), ['F-1', 'F-2']);
    assert.strictEqual(world.sources[0].columnMap[KEY_ID].col, 2, 'the map follows the column');
    assert.strictEqual(world.sources[0].columnMap[KEY_ID].key, true);
    assert.deepStrictEqual(world.sources[0].identity, { mode: 'key', keyFieldId: KEY_ID });

    reset();
    world.file.buffer = csv(['Leverancier;Totaal', 'Acme;10', 'Bee;20']);
    out = await run(mirror(), { reason: 'manual' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    assert.deepStrictEqual(idsWritten(), ['r2', 'r3']);
    assert.ok(out.warnings.some(w => /key column is not in the header any more/.test(w)), JSON.stringify(out.warnings));
    assert.strictEqual(world.finished[0].identity.mode, 'row');
    assert.deepStrictEqual(world.sources[0].identity, { mode: 'key', keyFieldId: KEY_ID }, 'the stored identity waits for the column to return');
});

test('a new column is inferred once and reported; a known column keeps its declared type whatever the cells say', async () => {
    world.file.buffer = csv(['Factuurnummer;Leverancier;Totaal;Betaald', 'F-1;Acme;abc;ja', 'F-2;Bee;def;nee']);
    const out = await run(mirror(), { reason: 'manual' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    assert.ok(out.warnings.some(w => /New column "Betaald" arrived as bool/.test(w)), JSON.stringify(out.warnings));
    const map = world.sources[0].columnMap;
    const betaald = Object.entries(map).find(([, e]) => e.header === 'Betaald');
    assert.strictEqual(betaald[1].type, 'bool');
    assert.match(betaald[0], /bol$/);
    const totaal = Object.entries(map).find(([, e]) => e.header === 'Totaal');
    assert.strictEqual(totaal[1].type, 'number', 'declared once, never re-inferred from "abc"');
    assert.deepStrictEqual(world.finished[0].coercion, { totaal: 2 });
    assert.ok(world.finished[0].columnsChanged.includes('added:betaald'));
});

test('a retype declared through the settings arrives as a new field id under the same key, and the identity follows it', async () => {
    const m = mirror();
    m.source.columnMap = { ...m.source.columnMap, [KEY_ID]: { ...m.source.columnMap[KEY_ID], type: 'number' } };
    world.file.buffer = csv(['Factuurnummer;Leverancier;Totaal', '1001;Acme;10', '1002;Bee;20']);
    const out = await run(m, { reason: 'settings' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    const newId = KEY_ID.replace(/txt$/, 'num');
    assert.ok(world.sources[0].columnMap[newId], 'the map is keyed by the new id');
    assert.strictEqual(world.sources[0].columnMap[KEY_ID], undefined);
    assert.deepStrictEqual(world.sources[0].identity, { mode: 'key', keyFieldId: newId });
    assert.deepStrictEqual(idsWritten(), ['1001', '1002']);
    assert.ok(world.finished[0].columnsChanged.includes('retyped:factuurnummer'), JSON.stringify(world.finished[0].columnsChanged));

    // a number key is minted from the number, not the file's spelling: '7,5'
    // is the id '7.5' a write-through answers, '1.000' is '1000'
    reset();
    const n = mirror();
    n.source.columnMap = { ...n.source.columnMap, [KEY_ID]: { ...n.source.columnMap[KEY_ID], type: 'number' } };
    world.file.buffer = csv(['Factuurnummer;Leverancier;Totaal', '7,5;Acme;10', '1.000;Bee;20', '7.50;Dup;30', 'abc;Nobody;40']);
    const o = await run(n, { reason: 'settings' });
    assert.strictEqual(o.ok, true, o.error && o.error.message);
    assert.deepStrictEqual(idsWritten(), ['7.5', '1000']);
    assert.deepStrictEqual(world.finished[0].identity, { mode: 'key', missing: 1, duplicate: 1 }, '7.50 is 7,5 again; abc is no number');
});

test('a native Sheet reads by cells: serial dates under a date column, one probe, no download', async () => {
    const dated = columns.fieldsFromSheet([{ col: 0, header: 'Datum', type: 'date' }, { col: 1, header: 'Naam', type: 'text' }], { keyCol: 1 });
    world.meta = { id: 'tbl_fac', key: 'facturen', fields: dated.fields };
    const m = mirror({ source: { ...mirror().source, format: 'gsheet', identity: { mode: 'key', keyFieldId: dated.keyFieldId }, columnMap: dated.columnMap, write: { mode: 'sheets_api', reason: null, caveats: [], sharedOptIn: false } } });
    const gapi = {
        ...api,
        probe: async () => { world.calls.push('probe'); return { marker: { version: '9' }, name: 'Sheet', size: null, format: 'gsheet', path: null, webUrl: null, owned: true, writable: true, file: { provider: 'google_drive', fileId: 'g1', format: 'gsheet' } }; },
        cells: {
            available: async () => true,
            listSheets: async () => [{ id: 0, name: 'Blad1', index: 0, hidden: false }],
            readSheet: async () => ({ rows: [['Datum', 'Naam'], [46266, 'Acme'], [46267.5, 'Bee']], errorCells: 0 }),
            sample: async () => ({ rows: [], numberFormat: new Map([[0, 'DATE']]), formulaCols: new Set() }),
        },
    };
    world.api = gapi;
    const out = await run(m, { reason: 'link' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    assert.deepStrictEqual(world.calls, ['probe']);
    assert.deepStrictEqual(idsWritten(), ['Acme', 'Bee']);
    assert.deepStrictEqual(upserts().map(s => s.params[5]), ['2026-09-01', '2026-09-02'], 'serials became ISO days');
});

test('the reader\'s cap says truncated: nothing is swept and the state says so', async () => {
    const m = mirror();
    m.source.rowCap = 1;
    world.existingIds = ['F-1', 'F-2', 'F-9'];
    const out = await run(m, { reason: 'manual' });
    assert.strictEqual(out.ok, true, out.error && out.error.message);
    assert.strictEqual(out.truncated, true);
    assert.deepStrictEqual(idsWritten(), ['F-1']);
    assert.strictEqual(world.batches.flat().some(s => /^DELETE/.test(s.sql)), false, 'no sweep on a partial read');
    assert.strictEqual(world.finished[0].truncated, true);
});

test('a storage refusal lands on the state with its code and a backoff', async () => {
    const { SpreadsheetSourceError } = require('./errors');
    world.api = { ...api, probe: async () => { throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', 'gone'); } };
    const out = await run(mirror({ syncState: { consecutiveErrors: 1 } }), { reason: 'schedule' });
    assert.strictEqual(out.ok, false);
    const fin = world.finished[0];
    assert.strictEqual(fin.status, 'error');
    assert.strictEqual(fin.lastErrorCode, 'spreadsheet_not_found');
    assert.strictEqual(fin.consecutiveErrors, 2);
    assert.ok(fin.nextRunAt);
});
