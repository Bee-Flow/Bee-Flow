'use strict';

/**
 * A SPREADSHEET MIRROR, END TO END, against a REAL Postgres.
 *
 * The same harness as routes/datatables.nextcloud.integration.test.js
 * (pglite, the genuine store/engine/planner/compiler, handlers invoked off
 * the route stack) with the storage replaced by an in-memory FileApi holding
 * real xlsx and csv BYTES with a version counter: link one workbook sheet
 * (key column) and one csv (row numbers) with a relation between them →
 * the physical tables get the inferred columns; the first refresh copies the
 * rows under the key values / `r<n>`; the same sheet again is refused; a
 * refresh on an unmoved marker downloads nothing and moves nothing; a header
 * rename drops the old column and refills the new; a retype through
 * PUT /:id/source swaps the column under the same key; a stale mark plus a
 * changed file re-downloads; a deleted row is swept; the ticker dispatches
 * by kind; the pulse answers and kicks. Then the WRITE-THROUGH: a row added
 * in Bee Flow is appended to the file first (exceljs, the other sheet and
 * the styles intact) and lands under its key; a stale token is a conflict
 * without a storage call; a rejected value changes nothing on either side;
 * the key column edited moves the row's id; a file that moved under us is
 * a 409 plus a pass; a 412 on the PUT is retried once on fresh bytes; a
 * delete removes the row from both sides — in row mode the copy is
 * renumbered by a pass the write marks for, and untouched csv lines stay
 * byte-identical; a blank line deleted from a row-mode file renumbers the
 * copy even though no cell changed; a bulk import is one upload; unlinking
 * leaves the file alone.
 *
 * Run: cd server && node --test routes/datatables.spreadsheet.integration.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');
const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adaptResult(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const command = fields.length > 0 ? 'SELECT' : String(sql).trim().split(/\s+/)[0].toUpperCase();
    const rowCount = fields.length > 0 ? rows.length : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command };
}
async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adaptResult(await pg.exec(sql), sql);
    return adaptResult(await pg.query(sql), sql);
}
const client = { query: (sql, params) => rawQuery(sql, params), release: () => {} };

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(SERVER, 'db.js'), {
    pool: { query: rawQuery, connect: async () => ({ ...client, query: async (sql, params) => (/pg_try_advisory_lock/.test(sql) ? { rows: [{ locked: true }] } : rawQuery(sql, params)) }) },
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql, []),
    getClient: async () => client,
    withTransaction: async (fn) => {
        await client.query('BEGIN');
        try { const out = await fn(client); await client.query('COMMIT'); return out; } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; }
    },
    makeStoreInit: (tag, schemaFn) => {
        let promise = null;
        return function ensureInit() {
            if (!promise) promise = Promise.resolve().then(schemaFn).catch((err) => { promise = null; throw err; });
            return promise;
        };
    },
    getRedis: () => null, redisHealthy: () => false,
    isSqlStateError: (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code),
});

const ORG = 'org-ss-a';
const OWNER = 'u-linker';
const USERS = { [OWNER]: { id: OWNER, organizationId: ORG, orgRole: 'member', groups: [] } };
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => USERS[id] || null,
    getAllGroups: async () => [],
    getOrganization: async () => ({ id: ORG }),
});
mock(path.join(SERVER, 'stores/projectStore'), {});
const pass = () => (req, res, next) => next();
mock(path.join(SERVER, 'auth'), {
    requirePermission: pass, requireActiveOrgForMutations: pass,
    assertUserCanUseOrg: async () => true, validateSharedGroupsForOrg: async (_r, g) => g || [],
    hasPermission: async () => true, Permissions: { MANAGE_DATATABLES: 'manage_datatables' },
});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), { requireBetaFeature: pass });
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: pass });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: pass });
mock(path.join(SERVER, 'core/integrations/integrationTools'), { isIntegrationPermittedForUser: async () => true });
mock(path.join(SERVER, 'integrations/nextcloudClient'), { resolveAuth: async () => null, isConnected: async () => false });
mock(path.join(SERVER, 'jobs/kbSourceRefresh'), { onDatatableChanged: () => {} });
mock(path.join(SERVER, 'core/webpages/webpageShareReconciler'), { onDatatableChanged: () => {} });
mock(path.join(SERVER, 'telemetry/metrics'), { recordJobRun: () => {}, recordAuthEvent: () => {} });

// ── The fake storage: real bytes, a version counter, a call log ───────────
const { formatOf } = require('../core/dataEngine/sources/spreadsheetFile/providers/index');
const { SpreadsheetSourceError } = require('../core/dataEngine/sources/spreadsheetFile/errors');
const PROVIDER = 'google_drive';
const FILES = new Map();   // fileId → { name, buffer, version, owned }
const CALLS = [];
const UPLOAD = { failOnce: false };
function putFile(id, name, buffer, { owned = true } = {}) {
    const prev = FILES.get(id);
    FILES.set(id, { name, buffer, version: prev ? prev.version + 1 : 1, owned });
}
function refOf(id, f) {
    return { provider: PROVIDER, fileId: id, driveId: null, path: null, name: f.name, mimeType: null, format: formatOf({ name: f.name }), size: f.buffer.length, modifiedAt: null, etag: null, webUrl: `https://drive.test/${id}`, parentId: 'root', isFolder: false, owned: f.owned, writable: true };
}
const fakeApi = {
    provider: PROVIDER,
    list: async ({ view, parentId, q }) => {
        CALLS.push(['list', view, parentId, q]);
        return { items: [...FILES.entries()].map(([id, f]) => refOf(id, f)), nextPageToken: null };
    },
    probe: async (file) => {
        CALLS.push(['probe', file.fileId]);
        const f = FILES.get(file.fileId);
        if (!f) throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', 'Google Drive no longer has this file.', { ref: { provider: PROVIDER, fileId: file.fileId } });
        const ref = refOf(file.fileId, f);
        return { marker: { version: String(f.version) }, name: f.name, size: f.buffer.length, mimeType: null, format: ref.format, path: null, webUrl: ref.webUrl, owned: f.owned, writable: true, file: ref };
    },
    download: async (file) => {
        CALLS.push(['download', file.fileId]);
        const f = FILES.get(file.fileId);
        return { buffer: f.buffer, marker: { version: String(f.version) } };
    },
    // The guarded PUT: the marker the bytes were derived from must still be
    // the file's, else 409 — what Drive's emulated version guard, Graph's
    // If-Match and Sabre's If-Match all come down to. `UPLOAD.failOnce`
    // plays a second writer who got there first.
    upload: async (file, buffer, { ifMatch }) => {
        CALLS.push(['upload', file.fileId, ifMatch ? String(ifMatch.version) : null]);
        const f = FILES.get(file.fileId);
        if (!f) throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', 'gone', { ref: { provider: PROVIDER, fileId: file.fileId } });
        if (UPLOAD.failOnce) {
            UPLOAD.failOnce = false;
            putFile(file.fileId, f.name, f.buffer, { owned: f.owned });
            throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'The file changed in Google Drive since this table was last refreshed.', { ref: { provider: PROVIDER, fileId: file.fileId } });
        }
        if (!ifMatch || String(ifMatch.version) !== String(f.version)) {
            throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'The file changed in Google Drive since this table was last refreshed.', { ref: { provider: PROVIDER, fileId: file.fileId } });
        }
        putFile(file.fileId, f.name, buffer, { owned: f.owned });
        return { marker: { version: String(FILES.get(file.fileId).version) } };
    },
    markerEquals: (a, b) => !!a && !!b && a.version != null && String(a.version) === String(b.version),
};
const fakeModule = {
    provider: PROVIDER, oauthProvider: 'google', integrationAppIds: ['google-drive'],
    isConnected: async () => ({ connected: true, reason: null }),
    forCaller: () => fakeApi, forLinker: () => fakeApi, markerEquals: fakeApi.markerEquals,
};
mock(path.join(SERVER, 'core/dataEngine/sources/spreadsheetFile/providers/index.js'), {
    providerFor: (name) => { if (name !== PROVIDER) { const e = new Error(`no ${name} here`); e.code = 'unknown_provider'; throw e; } return fakeModule; },
    formatOf,
});
mock(path.join(SERVER, 'core/dataEngine/sources/spreadsheetFile/credentials.js'), {
    resolveProviderCredential: async () => ({ userId: OWNER, oauthProvider: 'google' }),
    cheapStatus: async () => ({ connected: true, reason: null }),
    forget: () => {},
});
const linkerCalls = [];   // [source.linkedByUserId, opts] per resolveLinker
mock(path.join(SERVER, 'core/dataEngine/sources/spreadsheetFile/linkerAuth.js'), {
    resolveLinker: async (source, opts) => { linkerCalls.push([source && source.linkedByUserId, opts || {}]); return { api: fakeApi, userId: OWNER, session: {}, cred: {} }; },
    assertWritable: async () => {},
    forget: () => {},
});

const router = require('./datatables');
const datatableStore = require('../stores/datatableStore');
const datatableDbStore = require('../stores/datatableDbStore');
const sources = require('../core/dataEngine/sources');
const ExcelJS = require('exceljs');
const schemaOf = (orgId) => datatableDbStore.schemaNameFor('org', orgId);
const SC = datatableStore.orgScope(ORG);

function routeStack(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) return layer.route.stack.map(l => l.handle);
        // a mounted sub-router (/nextcloud, /spreadsheets): match its mount, then its own route
        if (!layer.route && layer.handle && layer.handle.stack && typeof layer.match === 'function' && layer.match(routePath)) {
            const prefix = routePath.split('/').slice(0, 2).join('/');
            for (const sub of layer.handle.stack) {
                if (sub.route && `${prefix}${sub.route.path}` === routePath && sub.route.methods[method]) return sub.route.stack.map(l => l.handle);
            }
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
async function call(method, routePath, req) {
    const res = { statusCode: 200, body: null, sent: false, headers: {}, text: '' };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.sent = true; return res; };
    res.setHeader = () => res; res.write = () => true; res.end = () => { res.sent = true; return res; };
    const full = { params: {}, query: {}, body: {}, headers: {}, ...req };
    for (const handle of routeStack(method, routePath)) {
        let advanced = false;
        await handle(full, res, () => { advanced = true; });
        if (res.sent || !advanced) break;
    }
    return res;
}
const as = (userId, over = {}) => ({ session: { user: { id: userId } }, ...over });
async function realRows(key) { return (await rawQuery(`SELECT * FROM "${schemaOf(ORG)}"."${key}" ORDER BY "id"`)).rows; }
async function columnTypes(key) {
    const r = await rawQuery(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schemaOf(ORG), key]);
    return Object.fromEntries(r.rows.map(x => [x.column_name, x.data_type]));
}
const tick = () => new Promise(r => setImmediate(() => setTimeout(r, 20)));
/** The table once a pass that FINISHED after `since` (ms) has settled — never the previous pass's state. */
async function settled(id, since = 0) {
    for (let i = 0; i < 100; i += 1) {
        const t = await datatableStore.getDatatable(id, SC);
        const s = t && t.syncState;
        if (s && s.status && s.status !== 'running' && Date.parse(s.lastSyncAt || 0) > since) return t;
        await tick();
    }
    throw new Error('sync never settled');
}

async function facturenXlsx({ amountHeader = 'Bedrag', rows = 3 } = {}) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Facturen');
    ws.addRow(['Datum', 'Factuurnummer', 'Leverancier', amountHeader, 'Betaald']);
    const data = [
        [new Date(Date.UTC(2026, 8, 1)), 'F-2026-001', 'Acme', 1234.5, true],
        [new Date(Date.UTC(2026, 8, 2)), 'F-2026-002', 'Bee', 99.5, false],
        [new Date(Date.UTC(2026, 8, 3)), 'F-2026-003', 'Cee', 7, true],
    ];
    for (const r of data.slice(0, rows)) {
        const row = ws.addRow(r);
        row.getCell(1).numFmt = 'dd-mm-yyyy';
    }
    const lev = wb.addWorksheet('Leveranciers');
    lev.addRow(['Naam', 'Stad']);
    lev.addRow(['Acme', 'Delft']);
    lev.addRow(['Bee', 'Delft']);
    return Buffer.from(await wb.xlsx.writeBuffer());
}
function klantenCsv(rows = [['Acme', 'Delft', '1.234,56'], ['Bee', 'Utrecht', '99,50']]) {
    const lines = ['Naam;Stad;Omzet', ...rows.map(r => r.join(';'))];
    return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

let facturenId = null;
let klantenId = null;
let describeColumns = null;

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await datatableStore.initDB();
    await pg.exec('CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, definition_json JSONB, last_run_at TIMESTAMPTZ)');
    putFile('xlsx1', 'Facturen 2026.xlsx', await facturenXlsx());
    putFile('csv1', 'klanten.csv', klantenCsv());
});
after(async () => { await pg.close(); });

test('GET /spreadsheets/providers lists the storages the account has a credential for', async () => {
    const res = await call('get', '/spreadsheets/providers', as(OWNER));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { providers: [{ provider: PROVIDER, connected: true }] });
});

test('GET /spreadsheets/browse lists folders and spreadsheet files with what is linked', async () => {
    const res = await call('get', '/spreadsheets/browse', as(OWNER, { query: { provider: PROVIDER, folderId: 'root' } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.provider, PROVIDER);
    assert.deepStrictEqual(res.body.folder, { id: 'root', name: '', path: [] });
    assert.deepStrictEqual(res.body.items.map(i => [i.id, i.name, i.kind, i.format, i.linkedAs]), [
        ['xlsx1', 'Facturen 2026.xlsx', 'file', 'xlsx', []],
        ['csv1', 'klanten.csv', 'file', 'csv', []],
    ]);
    assert.strictEqual(res.body.nextPageToken, null);
    const nc = await call('get', '/spreadsheets/browse', as(OWNER, { query: { provider: 'nextcloud_files', folderId: 'shared' } }));
    assert.strictEqual(nc.statusCode, 400, JSON.stringify(nc.body));
    assert.strictEqual(nc.body.code, 'no_shared_root');
    const bogus = await call('get', '/spreadsheets/browse', as(OWNER, { query: { provider: 'dropbox' } }));
    assert.strictEqual(bogus.statusCode, 400);
    assert.strictEqual(bogus.body.code, 'spreadsheet_rejected');
});

test('GET /spreadsheets/describe infers the columns, names the key candidates and the write mode', async () => {
    const res = await call('get', '/spreadsheets/describe', as(OWNER, { query: { provider: PROVIDER, fileId: 'xlsx1', sheet: 'Facturen' } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const b = res.body;
    assert.strictEqual(b.fileId, 'xlsx1');
    assert.strictEqual(b.format, 'xlsx');
    assert.strictEqual(b.owned, true);
    assert.deepStrictEqual(b.write, { mode: 'exceljs_put', reason: null, caveats: ['charts', 'pivots', 'vba', 'slicers'] });
    assert.deepStrictEqual(b.sheets.map(s => [s.name, s.hidden, s.linkedAs]), [['Facturen', false, []], ['Leveranciers', false, []]]);
    assert.strictEqual(b.sheet.name, 'Facturen');
    assert.strictEqual(b.sheet.headerRow, 1);
    assert.deepStrictEqual(b.sheet.columns.map(c => [c.col, c.letter, c.header, c.key, c.type, c.unique]), [
        [0, 'A', 'Datum', 'datum', 'date', false],
        [1, 'B', 'Factuurnummer', 'factuurnummer', 'text', true],
        [2, 'C', 'Leverancier', 'leverancier', 'text', true],
        [3, 'D', 'Bedrag', 'bedrag', 'number', true],
        [4, 'E', 'Betaald', 'betaald', 'bool', false],
    ]);
    assert.deepStrictEqual(b.keyCandidates, [1, 2, 3]);
    assert.strictEqual(b.sheet.preview.rows.length, 4);
    assert.deepStrictEqual(b.sheet.preview.rows[0], ['Datum', 'Factuurnummer', 'Leverancier', 'Bedrag', 'Betaald']);
    assert.deepStrictEqual(b.sheet.preview.rows[1], ['2026-09-01', 'F-2026-001', 'Acme', '1234.5', 'true']);
    assert.strictEqual(b.sheet.rowCount, 3);
    assert.strictEqual(b.sheet.truncated, false);
    describeColumns = b.sheet.columns.map(c => ({ col: c.col, header: c.header, type: c.type }));

    const csv = await call('get', '/spreadsheets/describe', as(OWNER, { query: { provider: PROVIDER, fileId: 'csv1' } }));
    assert.strictEqual(csv.statusCode, 200, JSON.stringify(csv.body));
    assert.deepStrictEqual(csv.body.sheets, [{ name: null, index: 0, rows: 3, cols: 3, hidden: false, linkedAs: [] }]);
    assert.deepStrictEqual(csv.body.sheet.columns.map(c => [c.header, c.type]), [['Naam', 'text'], ['Stad', 'text'], ['Omzet', 'number']]);
    assert.strictEqual(csv.body.write.mode, 'csv_put');

    const missing = await call('get', '/spreadsheets/describe', as(OWNER, { query: { provider: PROVIDER, fileId: 'xlsx1', sheet: 'Nope' } }));
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(missing.body.code, 'sheet_missing');
    assert.deepStrictEqual(missing.body.ref, { provider: PROVIDER, fileId: 'xlsx1', sheet: 'Nope' });
});

test('POST /spreadsheets/link makes both mirrors, copies the rows under key ids and r<n> ids, and fills the declared relation', async () => {
    CALLS.length = 0;
    const res = await call('post', '/spreadsheets/link', as(OWNER, {
        body: {
            scope: 'organisation',
            tables: [
                { provider: PROVIDER, fileId: 'xlsx1', sheet: 'Facturen', headerRow: 1, keyColumn: 1, columns: describeColumns, name: 'Facturen', key: 'facturen' },
                { provider: PROVIDER, fileId: 'csv1', name: 'Klanten', key: 'klanten' },
            ],
            relations: [{ from: { provider: PROVIDER, fileId: 'xlsx1', sheet: 'Facturen', col: 2 }, to: { provider: PROVIDER, fileId: 'csv1', col: 0 } }],
        },
    }));
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.datatables.length, 2);
    const [fac, kla] = res.body.datatables;
    facturenId = fac.id;
    klantenId = kla.id;
    assert.strictEqual(fac.managedKind, 'spreadsheet_file');
    assert.strictEqual(fac.source.kind, 'spreadsheet_file');
    assert.strictEqual(fac.source.provider, PROVIDER);
    assert.strictEqual(fac.source.fileId, 'xlsx1');
    assert.strictEqual(fac.source.fileName, 'Facturen 2026.xlsx');
    assert.strictEqual(fac.source.sheet, 'Facturen');
    assert.strictEqual(fac.source.writeMode, 'exceljs_put');
    assert.strictEqual(fac.source.writable, true);
    assert.strictEqual(fac.source.columnMap, undefined, 'the column map stays server-side');
    assert.strictEqual(fac.source.keyColumn.header, 'Factuurnummer');
    assert.match(fac.source.keyColumn.fieldId, /^fld_ss[0-9a-f]{10}txt$/);
    assert.deepStrictEqual(fac.source.columns.map(c => [c.col, c.header, c.type]), [[0, 'Datum', 'date'], [1, 'Factuurnummer', 'text'], [2, 'Leverancier', 'text'], [3, 'Bedrag', 'number'], [4, 'Betaald', 'bool']]);
    assert.deepStrictEqual(fac.source.relations.map(r => [r.kind, r.targetDatatableId]), [['match', klantenId]]);
    assert.strictEqual(kla.source.keyColumn, null, 'the csv is identified by row number');
    assert.strictEqual(kla.source.writeMode, 'csv_put');

    assert.deepStrictEqual(Object.keys(await columnTypes('facturen')), ['id', 'created_at', 'updated_at', 'created_by', 'org_id', 'datum', 'factuurnummer', 'leverancier', 'bedrag', 'betaald', 'klanten_ref']);
    const types = await columnTypes('facturen');
    assert.strictEqual(types.datum, 'date');
    assert.strictEqual(types.bedrag, 'numeric');
    assert.strictEqual(types.betaald, 'boolean');

    const facT = await settled(facturenId);
    assert.strictEqual(facT.syncState.status, 'ok', JSON.stringify(facT.syncState));
    assert.strictEqual(facT.syncState.written, 3);
    assert.deepStrictEqual(facT.syncState.identity, { mode: 'key', missing: 0, duplicate: 0 });
    assert.deepStrictEqual(facT.syncState.marker, { version: '1' });
    assert.match(facT.syncState.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(facT.syncState.lastFetchAt);
    assert.strictEqual(facT.rowCount, 3);
    const rows = await realRows('facturen');
    assert.deepStrictEqual(rows.map(r => [r.id, r.leverancier, Number(r.bedrag), r.betaald, r.klanten_ref]), [
        ['F-2026-001', 'Acme', 1234.5, true, 'r2'],
        ['F-2026-002', 'Bee', 99.5, false, 'r3'],
        ['F-2026-003', 'Cee', 7, true, null],
    ]);
    assert.strictEqual(new Date(rows[0].datum).toISOString().slice(0, 10), '2026-09-01');

    const klaT = await settled(klantenId);
    assert.strictEqual(klaT.syncState.status, 'ok', JSON.stringify(klaT.syncState));
    assert.deepStrictEqual((await realRows('klanten')).map(r => [r.id, r.naam, r.stad, Number(r.omzet)]), [['r2', 'Acme', 'Delft', 1234.56], ['r3', 'Bee', 'Utrecht', 99.5]]);
    assert.strictEqual(klaT.syncState.csv.delimiter, ';');
    assert.strictEqual(klaT.syncState.csv.bom, true);
    // the link's own validation probed both (in request order); the first
    // refreshes then probed the TARGET before the mirror that points at it —
    // and the bytes came from the download cache describe had just filled.
    assert.deepStrictEqual(CALLS.filter(c => c[0] === 'probe').map(c => c[1]), ['xlsx1', 'csv1', 'csv1', 'xlsx1']);
    assert.strictEqual(CALLS.some(c => c[0] === 'download'), false);
});

test('linking the same sheet again is refused as already_linked, and the browser now says so', async () => {
    const res = await call('post', '/spreadsheets/link', as(OWNER, { body: { tables: [{ provider: PROVIDER, fileId: 'xlsx1', sheet: 'Facturen', key: 'again' }] } }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'already_linked');
    assert.strictEqual(res.body.datatableId, facturenId);
    assert.deepStrictEqual(res.body.ref, { provider: PROVIDER, fileId: 'xlsx1', sheet: 'Facturen' });
    assert.strictEqual(await datatableStore.getDatatable(res.body.datatableId, SC).then(t => t && t.id), facturenId);
    const browse = await call('get', '/spreadsheets/browse', as(OWNER, { query: { provider: PROVIDER } }));
    assert.deepStrictEqual(browse.body.items.find(i => i.id === 'xlsx1').linkedAs, [{ datatableId: facturenId, sheet: 'Facturen' }]);
    const desc = await call('get', '/spreadsheets/describe', as(OWNER, { query: { provider: PROVIDER, fileId: 'xlsx1', sheet: 'Leveranciers' } }));
    assert.deepStrictEqual(desc.body.sheets.map(s => s.linkedAs), [[facturenId], []]);
    // a non-unique key column is refused before anything is made
    const dup = await call('post', '/spreadsheets/link', as(OWNER, { body: { tables: [{ provider: PROVIDER, fileId: 'xlsx1', sheet: 'Leveranciers', keyColumn: 1, key: 'bystad' }] } }));
    assert.strictEqual(dup.statusCode, 422, JSON.stringify(dup.body));
    assert.strictEqual(dup.body.code, 'key_not_unique');
    assert.match(dup.body.error, /"Stad" cannot be the key: 1 rows repeat a value \("Delft"\)/);
    assert.strictEqual((await datatableStore.listSourceMirrorsInScope(SC)).length, 2, 'nothing was made');
    const since = Date.now();
    const ok = await call('post', '/spreadsheets/link', as(OWNER, { body: { tables: [{ provider: PROVIDER, fileId: 'xlsx1', sheet: 'Leveranciers', keyColumn: 0, key: 'bynaam' }] } }));
    assert.strictEqual(ok.statusCode, 201, JSON.stringify(ok.body));
    const lev = await settled(ok.body.datatables[0].id, since);
    assert.deepStrictEqual((await realRows('bynaam')).map(r => r.id), ['Acme', 'Bee']);
    assert.strictEqual(lev.name, 'Facturen 2026 – Leveranciers', 'the default name is file – sheet');
    await call('delete', '/:id', as(OWNER, { params: { id: lev.id } }));
});

test('a refresh on an unmoved marker downloads nothing and leaves updated_at and data_version alone', async () => {
    const before = (await realRows('facturen')).map(r => String(r.updated_at));
    const version = (await datatableStore.getDatatable(facturenId, SC)).dataVersion;
    CALLS.length = 0;
    const res = await call('post', '/:id/source/refresh', as(OWNER, { params: { id: facturenId } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.sync.skipped, 'unchanged');
    assert.strictEqual(res.body.sync.written, 0);
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe']);
    assert.deepStrictEqual((await realRows('facturen')).map(r => String(r.updated_at)), before);
    assert.strictEqual((await datatableStore.getDatatable(facturenId, SC)).dataVersion, version);
});

test('GET /:id/source projects the source without the column map; PUT /:id/schema is refused', async () => {
    const res = await call('get', '/:id/source', as(OWNER, { params: { id: facturenId } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.source.columnMap, undefined);
    assert.strictEqual(res.body.source.headerRow, 1);
    assert.strictEqual(res.body.sync.marker.version, '1');
    const schema = await call('put', '/:id/schema', as(OWNER, { params: { id: facturenId }, body: { fields: [], expectedVersion: 1 } }));
    assert.strictEqual(schema.statusCode, 409);
    assert.strictEqual(schema.body.code, 'schema_from_source');
});

test('a header renamed in the file drops the old column and refills the new one under a new key', async () => {
    putFile('xlsx1', 'Facturen 2026.xlsx', await facturenXlsx({ amountHeader: 'Totaal' }));
    CALLS.length = 0;
    const res = await call('post', '/:id/source/refresh', as(OWNER, { params: { id: facturenId } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, true, JSON.stringify(res.body));
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'download']);
    assert.ok(res.body.sync.columnsChanged.includes('removed:bedrag'), JSON.stringify(res.body.sync.columnsChanged));
    assert.ok(res.body.sync.columnsChanged.includes('added:totaal'));
    assert.ok(res.body.warnings.some(w => /New column "Totaal" arrived as number/.test(w)), JSON.stringify(res.body.warnings));
    const types = await columnTypes('facturen');
    assert.strictEqual(types.bedrag, undefined);
    assert.strictEqual(types.totaal, 'numeric');
    assert.deepStrictEqual((await realRows('facturen')).map(r => [r.id, Number(r.totaal)]), [['F-2026-001', 1234.5], ['F-2026-002', 99.5], ['F-2026-003', 7]]);
    assert.strictEqual(res.body.sync.marker.version, '2');
});

test('PUT /:id/source retypes a column: same key, new field id, DROP + ADD, refilled', async () => {
    const src = (await call('get', '/:id/source', as(OWNER, { params: { id: facturenId } }))).body.source;
    const totaal = src.columns.find(c => c.header === 'Totaal');
    assert.match(totaal.fieldId, /num$/);
    const bad = await call('put', '/:id/source', as(OWNER, { params: { id: facturenId }, body: { schedule: { everyMinutes: 5 } } }));
    assert.strictEqual(bad.statusCode, 400);
    assert.strictEqual(bad.body.code, 'unknown_field');
    const since = Date.now();
    const res = await call('put', '/:id/source', as(OWNER, { params: { id: facturenId }, body: { columns: { [totaal.fieldId]: { type: 'text' } } } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const after = await settled(facturenId, since);
    assert.strictEqual(after.syncState.lastReason, 'settings');
    assert.strictEqual(after.syncState.status, 'ok', JSON.stringify(after.syncState));
    assert.ok(after.syncState.columnsChanged.includes('retyped:totaal'), JSON.stringify(after.syncState.columnsChanged));
    const schema = (await call('get', '/:id/schema', as(OWNER, { params: { id: facturenId } }))).body.fields;
    const f = schema.find(x => x.key === 'totaal');
    assert.strictEqual(f.type, 'text');
    assert.match(f.id, /txt$/);
    assert.strictEqual((await columnTypes('facturen')).totaal, 'text');
    assert.strictEqual((await realRows('facturen'))[0].totaal, '1234.5');
    assert.strictEqual(after.source.identity.keyFieldId, src.keyColumn.fieldId, 'the key column did not move');
});

test('PUT /:id/source can move the identity to another key column; every row id changes in one pass', async () => {
    const src = (await call('get', '/:id/source', as(OWNER, { params: { id: facturenId } }))).body.source;
    let since = Date.now();
    const res = await call('put', '/:id/source', as(OWNER, { params: { id: facturenId }, body: { keyColumn: 2 } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.datatable.source.keyColumn.header, 'Leverancier');
    const after = await settled(facturenId, since);
    assert.strictEqual(after.syncState.status, 'ok', JSON.stringify(after.syncState));
    assert.deepStrictEqual((await realRows('facturen')).map(r => r.id), ['Acme', 'Bee', 'Cee']);
    assert.strictEqual(after.syncState.written, 3);
    assert.strictEqual(after.syncState.deleted, 3);
    assert.strictEqual(after.source.identity.keyFieldId, src.columns.find(c => c.header === 'Leverancier').fieldId);
    // and back
    since = Date.now();
    await call('put', '/:id/source', as(OWNER, { params: { id: facturenId }, body: { keyColumn: 1 } }));
    const back = await settled(facturenId, since);
    assert.strictEqual(back.source.identity.keyFieldId, src.keyColumn.fieldId);
    assert.deepStrictEqual((await realRows('facturen')).map(r => r.id), ['F-2026-001', 'F-2026-002', 'F-2026-003']);
});

test('a stale mark plus a changed file re-downloads and patches the row (the file.changed path)', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(FILES.get('xlsx1').buffer);
    wb.getWorksheet('Facturen').getRow(3).getCell(3).value = 'Bee Flow';
    putFile('xlsx1', 'Facturen 2026.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    await datatableStore.markSourceStale(facturenId, 'event');
    CALLS.length = 0;
    const since = Date.now();
    const fresh = await datatableStore.getDatatable(facturenId, SC);
    assert.strictEqual(sources.kickStale(fresh, { reason: 'event', delayMs: 0 }), true);
    const after = await settled(facturenId, since);
    assert.strictEqual(after.syncState.lastReason, 'event');
    assert.strictEqual(after.syncState.status, 'ok', JSON.stringify(after.syncState));
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'download']);
    assert.strictEqual(after.syncState.staleReason, null);
    assert.strictEqual((await realRows('facturen')).find(r => r.id === 'F-2026-002').leverancier, 'Bee Flow');
    assert.strictEqual(after.syncState.written, 1, 'only the changed row was rewritten');
});

test('the sync sweeps rows the file no longer has', async () => {
    putFile('xlsx1', 'Facturen 2026.xlsx', await facturenXlsx({ amountHeader: 'Totaal', rows: 2 }));
    const res = await call('post', '/:id/source/refresh', as(OWNER, { params: { id: facturenId } }));
    assert.strictEqual(res.body.ok, true, JSON.stringify(res.body));
    assert.strictEqual(res.body.sync.deleted, 1);
    assert.deepStrictEqual((await realRows('facturen')).map(r => r.id), ['F-2026-001', 'F-2026-002']);
    assert.strictEqual((await datatableStore.getDatatable(facturenId, SC)).rowCount, 2);
});

test('the ticker sees a due spreadsheet mirror and runs it through the registry, by kind', async () => {
    await datatableStore.finishSourceSync(klantenId, { nextRunAt: '2000-01-01T00:00:00.000Z', status: 'ok' });
    const due = await datatableStore.listDueSourceSyncs(10);
    const mine = due.find(t => t.id === klantenId);
    assert.ok(mine, 'due');
    assert.strictEqual(mine.managedKind, 'spreadsheet_file');
    CALLS.length = 0;
    const job = require('../jobs/datatableNcSync');
    const r = await job.syncOne(mine);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(CALLS.map(c => [c[0], c[1]]), [['probe', 'csv1']]);
    assert.strictEqual((await datatableStore.getDatatable(klantenId, SC)).syncState.lastReason, 'schedule');
});

test('GET /:id/source/pulse answers the version and kicks a re-check when the last look is old', async () => {
    await datatableStore.finishSourceSync(klantenId, { status: 'ok', lastSuccessAt: '2000-01-01T00:00:00.000Z' });
    CALLS.length = 0;
    const since = Date.now();
    const res = await call('get', '/:id/source/pulse', as(OWNER, { params: { id: klantenId } }));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Number.isInteger(res.body.dataVersion));
    assert.strictEqual(res.body.rowCount, 2);
    assert.strictEqual(res.body.sync.status, 'ok');
    const after = await settled(klantenId, since);
    assert.strictEqual(after.syncState.lastReason, 'live');
    assert.strictEqual(after.syncState.skipped, 'unchanged');
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe']);
});

async function sheetRows(fileId, sheet) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(FILES.get(fileId).buffer);
    const ws = wb.getWorksheet(sheet);
    const out = [];
    ws.eachRow((row, n) => { out.push([n, ...row.values.slice(1).map(v => (v instanceof Date ? v.toISOString().slice(0, 10) : v))]); });
    return { rows: out, ws };
}

test('POST /:id/rows appends to the file FIRST (the other sheet intact) and lands under its key; the next probe reads unchanged', async () => {
    CALLS.length = 0;
    const before = FILES.get('xlsx1').version;
    const res = await call('post', '/:id/rows', as(OWNER, { params: { id: facturenId }, body: { values: { factuurnummer: 'F-2026-009', leverancier: 'Acme', datum: '2026-09-09', totaal: '12', betaald: 'yes' } } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.id, 'F-2026-009', 'the key IS the id');
    // probe → (bytes were cached by the sweep pass) → one guarded upload
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'upload']);
    assert.strictEqual(CALLS[1][2], String(before), 'If-Match carries the marker the bytes were read at');
    assert.strictEqual(FILES.get('xlsx1').version, before + 1);
    const { rows, ws } = await sheetRows('xlsx1', 'Facturen');
    assert.deepStrictEqual(rows[3], [4, '2026-09-09', 'F-2026-009', 'Acme', '12', true]);
    assert.strictEqual(ws.getRow(4).getCell(1).numFmt, 'dd-mm-yyyy', 'the new row inherits the style of the row above');
    assert.deepStrictEqual((await sheetRows('xlsx1', 'Leveranciers')).rows, [[1, 'Naam', 'Stad'], [2, 'Acme', 'Delft'], [3, 'Bee', 'Delft']], 'the other sheet is untouched');
    const copy = (await realRows('facturen')).find(r => r.id === 'F-2026-009');
    assert.ok(copy, 'the copy has the row');
    assert.strictEqual(copy.leverancier, 'Acme');
    assert.strictEqual(copy.betaald, true);
    assert.strictEqual(copy.totaal, '12');
    assert.strictEqual(new Date(copy.datum).toISOString().slice(0, 10), '2026-09-09');
    assert.strictEqual(copy.klanten_ref, 'r2', 'the relation column is derived on the way in');
    assert.strictEqual(copy.created_by, OWNER);
    const t = await datatableStore.getDatatable(facturenId, SC);
    assert.strictEqual(t.rowCount, 3);
    assert.strictEqual(t.syncState.marker.version, String(before + 1), 'the write recorded the new marker');
    assert.ok(t.syncState.lastWriteAt);
    assert.strictEqual(t.syncState.staleReason, undefined === t.syncState.staleReason ? undefined : null);
    // our own write never costs a download: the next look is one probe and "unchanged"
    CALLS.length = 0;
    const again = await call('post', '/:id/source/refresh', as(OWNER, { params: { id: facturenId } }));
    assert.strictEqual(again.body.sync.skipped, 'unchanged', JSON.stringify(again.body.sync));
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe']);
    assert.strictEqual((await realRows('facturen')).length, 3);
});

test('PUT /:id/rows/:rowId: a stale token is a conflict and a rejected value a 422 naming the column, neither reaching the file; a good one changes both sides', async () => {
    CALLS.length = 0;
    const version = FILES.get('xlsx1').version;
    const stale = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-001' }, body: { expectedUpdatedAt: '2000-01-01T00:00:00.000Z', values: { leverancier: 'X' } } }));
    assert.strictEqual(stale.statusCode, 409);
    assert.strictEqual(stale.body.code, 'row_conflict');
    const cur = (await call('get', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-001' } }))).body.row;
    const token = new Date(cur.updated_at).toISOString();
    const bad = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-001' }, body: { expectedUpdatedAt: token, values: { betaald: 'maybe' } } }));
    assert.strictEqual(bad.statusCode, 422, JSON.stringify(bad.body));
    assert.strictEqual(bad.body.code, 'spreadsheet_rejected');
    assert.match(bad.body.error, /^Betaald: "maybe" is not yes or no/);
    const derived = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-001' }, body: { expectedUpdatedAt: token, values: { klanten_ref: 'r3' } } }));
    assert.strictEqual(derived.statusCode, 400);
    assert.strictEqual(derived.body.code, 'derived_column');
    assert.deepStrictEqual(CALLS, [], 'none of those reached the storage');
    assert.strictEqual(FILES.get('xlsx1').version, version);
    assert.strictEqual((await realRows('facturen')).find(r => r.id === 'F-2026-001').leverancier, 'Acme');

    const ok = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-001' }, body: { expectedUpdatedAt: token, values: { leverancier: 'Bee Flow BV', betaald: false } } }));
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.row.leverancier, 'Bee Flow BV');
    assert.strictEqual(ok.body.row.betaald, false);
    assert.strictEqual(ok.body.row.klanten_ref, null, 'no customer of that name: the relation re-resolves to nothing');
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'upload']);
    assert.strictEqual(FILES.get('xlsx1').version, version + 1);
    const { rows } = await sheetRows('xlsx1', 'Facturen');
    assert.deepStrictEqual(rows[1].slice(2), ['F-2026-001', 'Bee Flow BV', 1234.5, false]);
    assert.deepStrictEqual(rows[2].slice(2), ['F-2026-002', 'Bee', 99.5, false], 'the other rows are as they were');
});

test('the key column edited: the file changes and the copy row moves to its new id', async () => {
    const cur = (await call('get', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-002' } }))).body.row;
    const res = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-002' }, body: { expectedUpdatedAt: new Date(cur.updated_at).toISOString(), values: { factuurnummer: 'F-2026-022' } } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.row.id, 'F-2026-022');
    assert.strictEqual(res.body.row.factuurnummer, 'F-2026-022');
    assert.strictEqual(res.body.row.leverancier, 'Bee');
    assert.deepStrictEqual((await realRows('facturen')).map(r => r.id), ['F-2026-001', 'F-2026-009', 'F-2026-022']);
    assert.strictEqual((await sheetRows('xlsx1', 'Facturen')).rows[2][2], 'F-2026-022');
    assert.strictEqual((await call('get', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-002' } }))).statusCode, 404);
    // a key another row has is refused, and the file is not touched
    const version = FILES.get('xlsx1').version;
    const dup = await call('post', '/:id/rows', as(OWNER, { params: { id: facturenId }, body: { values: { factuurnummer: 'F-2026-022' } } }));
    assert.strictEqual(dup.statusCode, 409);
    assert.strictEqual(dup.body.code, 'key_duplicate');
    const blank = await call('post', '/:id/rows', as(OWNER, { params: { id: facturenId }, body: { values: { leverancier: 'no key' } } }));
    assert.strictEqual(blank.statusCode, 422);
    assert.strictEqual(blank.body.code, 'key_missing');
    assert.strictEqual(FILES.get('xlsx1').version, version);
});

test('a file that moved under us: the write is a 409 before anything is written, and a pass brings the copy up to date', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(FILES.get('xlsx1').buffer);
    wb.getWorksheet('Facturen').getRow(2).getCell(3).value = 'Acme NV';
    putFile('xlsx1', 'Facturen 2026.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    const version = FILES.get('xlsx1').version;
    CALLS.length = 0;
    const since = Date.now();
    const res = await call('post', '/:id/rows', as(OWNER, { params: { id: facturenId }, body: { values: { factuurnummer: 'F-2026-010', leverancier: 'Dee' } } }));
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'spreadsheet_conflict');
    assert.match(res.body.error, /being refreshed now/);
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe'], 'nothing was uploaded');
    assert.strictEqual(FILES.get('xlsx1').version, version);
    const after = await settled(facturenId, since);
    assert.strictEqual(after.syncState.lastReason, 'conflict');
    assert.strictEqual(after.syncState.status, 'ok', JSON.stringify(after.syncState));
    assert.strictEqual(after.syncState.staleReason, null);
    assert.strictEqual((await realRows('facturen')).find(r => r.id === 'F-2026-001').leverancier, 'Acme NV');
    assert.strictEqual((await realRows('facturen')).length, 3);
    // and now the same write goes through
    const retry = await call('post', '/:id/rows', as(OWNER, { params: { id: facturenId }, body: { values: { factuurnummer: 'F-2026-010', leverancier: 'Dee' } } }));
    assert.strictEqual(retry.statusCode, 200, JSON.stringify(retry.body));
    assert.strictEqual((await realRows('facturen')).length, 4);
});

test('a 412 on the PUT (a second writer got there first) is retried once on fresh bytes, and the copy is flagged for a pass', async () => {
    UPLOAD.failOnce = true;
    CALLS.length = 0;
    const since = Date.now();
    const version = FILES.get('xlsx1').version;
    const res = await call('post', '/:id/rows', as(OWNER, { params: { id: facturenId }, body: { values: { factuurnummer: 'F-2026-011', leverancier: 'Eee' } } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'upload', 'probe', 'download', 'upload']);
    assert.strictEqual(CALLS[1][2], String(version));
    assert.strictEqual(CALLS[4][2], String(version + 1), 'the retry carries the fresh marker');
    assert.strictEqual(FILES.get('xlsx1').version, version + 2);
    assert.ok((await sheetRows('xlsx1', 'Facturen')).rows.some(r => r[2] === 'F-2026-011'));
    const after = await settled(facturenId, since);
    assert.strictEqual(after.syncState.lastReason, 'write', 'someone else changed the file: a pass re-reads it');
    assert.strictEqual(after.syncState.status, 'ok', JSON.stringify(after.syncState));
    assert.strictEqual((await realRows('facturen')).length, 5);
});

test('POST /:id/rows/bulk on a mirror is ONE upload for the whole import, with per-line refusals beside it', async () => {
    CALLS.length = 0;
    const res = await call('post', '/:id/rows/bulk', as(OWNER, { params: { id: facturenId }, body: { rows: [
        { factuurnummer: 'F-2026-101', leverancier: 'Acme', totaal: '1' },
        { factuurnummer: 'F-2026-102', betaald: 'perhaps' },
        { factuurnummer: 'F-2026-103', leverancier: 'Bee', totaal: '3' },
    ] } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.inserted, 2);
    assert.deepStrictEqual(res.body.errors.map(e => [e.line, e.code]), [[2, 'spreadsheet_rejected']]);
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'upload'], 'one download (cached), one upload');
    const ids = (await realRows('facturen')).map(r => r.id);
    assert.ok(ids.includes('F-2026-101') && ids.includes('F-2026-103') && !ids.includes('F-2026-102'));
    assert.strictEqual((await realRows('facturen')).find(r => r.id === 'F-2026-101').klanten_ref, 'r2');
    assert.strictEqual((await sheetRows('xlsx1', 'Facturen')).rows.length, 8);
});

test('DELETE /:id/rows/:rowId removes the row from the file and the copy (key mode: no renumbering)', async () => {
    CALLS.length = 0;
    const res = await call('delete', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-101' } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'upload']);
    assert.strictEqual((await sheetRows('xlsx1', 'Facturen')).rows.some(r => r[2] === 'F-2026-101'), false);
    assert.strictEqual((await realRows('facturen')).some(r => r.id === 'F-2026-101'), false);
    assert.strictEqual((await datatableStore.getDatatable(facturenId, SC)).syncState.lastReason, 'write', 'the last pass was the conflict one');
    assert.strictEqual((await call('delete', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: 'F-2026-101' } }))).statusCode, 404);
    // the bulk delete: one upload for the selection
    CALLS.length = 0;
    const bulk = await call('post', '/:id/rows/bulk-delete', as(OWNER, { params: { id: facturenId }, body: { ids: ['F-2026-103', 'F-2026-011', 'nope'] } }));
    assert.strictEqual(bulk.statusCode, 200, JSON.stringify(bulk.body));
    assert.deepStrictEqual(bulk.body, { deleted: 2, requested: 3 });
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'upload']);
    assert.deepStrictEqual((await realRows('facturen')).map(r => r.id), ['F-2026-001', 'F-2026-009', 'F-2026-010', 'F-2026-022']);
    assert.strictEqual((await sheetRows('xlsx1', 'Facturen')).rows.length, 5);
});

test('row mode (csv): a delete rewrites the file with the untouched line byte-identical, and a forced pass renumbers the copy', async () => {
    const before = FILES.get('csv1').buffer;
    CALLS.length = 0;
    const since = Date.now();
    const res = await call('delete', '/:id/rows/:rowId', as(OWNER, { params: { id: klantenId, rowId: 'r2' } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    // the bytes were cached by the link's read; the pass the delete marks
    // for probes and reads the bytes we put there from the cache
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'upload', 'probe']);
    const after = FILES.get('csv1').buffer;
    assert.deepStrictEqual([...after.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'the BOM is kept');
    assert.strictEqual(after.toString('utf8'), before.toString('utf8').replace('Acme;Delft;1.234,56\r\n', ''), 'only the deleted line is gone; the rest is byte-identical');
    assert.strictEqual(res.body.renumbered, true, 'no pass was running: renumbered on the spot');
    const t = await settled(klantenId, since);
    assert.strictEqual(t.syncState.lastReason, 'write');
    assert.strictEqual(t.syncState.status, 'ok', JSON.stringify(t.syncState));
    assert.strictEqual(t.syncState.staleReason, null, 'the mark the delete set was consumed by that pass');
    assert.deepStrictEqual((await realRows('klanten')).map(r => [r.id, r.naam]), [['r2', 'Bee']], 'Bee moved up from r3 to r2');
    assert.strictEqual(t.rowCount, 1);
    // a row-mode append lands under the row it was written at
    const ins = await call('post', '/:id/rows', as(OWNER, { params: { id: klantenId }, body: { values: { naam: 'Cee', stad: 'Delft', omzet: '7' } } }));
    assert.strictEqual(ins.statusCode, 200, JSON.stringify(ins.body));
    assert.strictEqual(ins.body.id, 'r3');
    assert.strictEqual(FILES.get('csv1').buffer.toString('utf8').split('\r\n')[2], 'Cee;Delft;7', 'the decimal comma dialect is kept');
    assert.deepStrictEqual((await realRows('klanten')).map(r => [r.id, r.naam, Number(r.omzet)]), [['r2', 'Bee', 99.5], ['r3', 'Cee', 7]]);
});

test('row mode: a blank line deleted from the file — no cell changed, every row under it moved — is NOT "unchanged": the copy is renumbered by the next pass', async () => {
    // the owner leaves a blank line between the rows: the copy says r2 and r4
    putFile('csv1', 'klanten.csv', klantenCsv([['Bee', 'Utrecht', '99,50'], ['', '', ''], ['Cee', 'Delft', '7']]));
    let res = await call('post', '/:id/source/refresh', as(OWNER, { params: { id: klantenId } }));
    assert.strictEqual(res.body.ok, true, JSON.stringify(res.body));
    assert.deepStrictEqual((await realRows('klanten')).map(r => [r.id, r.naam]), [['r2', 'Bee'], ['r4', 'Cee']]);
    // then removes it: every cell identical, Cee moved from row 4 to row 3
    putFile('csv1', 'klanten.csv', klantenCsv([['Bee', 'Utrecht', '99,50'], ['Cee', 'Delft', '7']]));
    CALLS.length = 0;
    res = await call('post', '/:id/source/refresh', as(OWNER, { params: { id: klantenId } }));
    assert.strictEqual(res.body.ok, true, JSON.stringify(res.body));
    assert.notStrictEqual(res.body.sync.skipped, 'unchanged', 'the same cells at other row numbers are another sheet to a copy keyed by row number');
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe', 'download']);
    assert.deepStrictEqual((await realRows('klanten')).map(r => [r.id, r.naam]), [['r2', 'Bee'], ['r3', 'Cee']], 'r4 is gone, Cee is r3');
    assert.strictEqual(res.body.sync.deleted, 1);
    // …so an update of r3 reaches Cee's line, not a row that is no longer there
    const cur = (await call('get', '/:id/rows/:rowId', as(OWNER, { params: { id: klantenId, rowId: 'r3' } }))).body.row;
    const upd = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: klantenId, rowId: 'r3' }, body: { expectedUpdatedAt: new Date(cur.updated_at).toISOString(), values: { stad: 'Leiden' } } }));
    assert.strictEqual(upd.statusCode, 200, JSON.stringify(upd.body));
    assert.strictEqual(FILES.get('csv1').buffer.toString('utf8').split('\r\n')[2], 'Cee;Leiden;7');
    assert.strictEqual((await realRows('klanten')).find(r => r.id === 'r3').stad, 'Leiden');
    // and the write recorded the pass's own hash: the next look is one probe and "unchanged"
    CALLS.length = 0;
    const again = await call('post', '/:id/source/refresh', as(OWNER, { params: { id: klantenId } }));
    assert.strictEqual(again.body.sync.skipped, 'unchanged', JSON.stringify(again.body.sync));
    assert.deepStrictEqual(CALLS.map(c => c[0]), ['probe']);
});

test('a read-only file (not owned, no opt-in) is refused before any storage call', async () => {
    putFile('csv2', 'shared.csv', klantenCsv(), { owned: false });
    const link = await call('post', '/spreadsheets/link', as(OWNER, { body: { tables: [{ provider: PROVIDER, fileId: 'csv2', key: 'shared' }] } }));
    assert.strictEqual(link.statusCode, 201, JSON.stringify(link.body));
    const shared = link.body.datatables[0];
    assert.strictEqual(shared.source.writable, false);
    assert.strictEqual(shared.source.writeReason, 'not_owned');
    await settled(shared.id);
    CALLS.length = 0;
    const res = await call('post', '/:id/rows', as(OWNER, { params: { id: shared.id }, body: { values: { naam: 'X' } } }));
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'spreadsheet_write_unsupported');
    assert.match(res.body.error, /belongs to someone else/);
    assert.deepStrictEqual(CALLS, []);
    await call('delete', '/:id', as(OWNER, { params: { id: shared.id } }));
});

test('DELETE /:id unlinks the mirror and leaves the file untouched', async () => {
    const version = FILES.get('xlsx1').version;
    CALLS.length = 0;
    const res = await call('delete', '/:id', as(OWNER, { params: { id: facturenId } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(FILES.get('xlsx1').version, version);
    assert.strictEqual(CALLS.length, 0);
    assert.strictEqual(await datatableStore.getDatatable(facturenId, SC), null);
    // the relation target is still there and still readable
    assert.strictEqual((await realRows('klanten')).length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// S2 — the wire contract of a refusal, end to end through the real store:
// a technical name already taken in the scope; a new key column that does
// not identify rows, refused at link AND at settings time; the fields the
// client builds its sentence from (header, detail, key) on the body.
// Appended as its own block: the tables it links are its own and deleted
// at the end, so the state the tests above leave behind is untouched.
// ═══════════════════════════════════════════════════════════════════════════

test('S2: POST /spreadsheets/link refuses a technical name an existing table has with 409 key_taken naming the key — nothing made', async () => {
    const before = (await datatableStore.listDatatablesForScope(SC)).length;
    const res = await call('post', '/spreadsheets/link', as(OWNER, { body: { tables: [{ provider: PROVIDER, fileId: 'xlsx1', sheet: 'Leveranciers', keyColumn: 0, key: 'klanten' }] } }));
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'key_taken');
    assert.strictEqual(res.body.key, 'klanten', 'the key, for the wizard to mark the names step');
    assert.match(res.body.error, /technical name "klanten"/);
    assert.strictEqual((await datatableStore.listDatatablesForScope(SC)).length, before, 'nothing made');
});

test('S2: a key refusal at link time ships header and detail; the same key change through PUT /:id/source is refused the same way, and the copy keeps its ids', async () => {
    // Leveranciers: Naam (Acme, Bee) is unique, Stad (Delft, Delft) is not
    const dup = await call('post', '/spreadsheets/link', as(OWNER, { body: { tables: [{ provider: PROVIDER, fileId: 'xlsx1', sheet: 'Leveranciers', keyColumn: 1, key: 's2_bystad' }] } }));
    assert.strictEqual(dup.statusCode, 422, JSON.stringify(dup.body));
    assert.strictEqual(dup.body.code, 'key_not_unique');
    assert.strictEqual(dup.body.header, 'Stad', 'the column, on the wire');
    assert.strictEqual(dup.body.detail, '1 rows repeat a value ("Delft")');
    assert.deepStrictEqual(dup.body.ref, { provider: PROVIDER, fileId: 'xlsx1', sheet: 'Leveranciers' });

    const since = Date.now();
    const ok = await call('post', '/spreadsheets/link', as(OWNER, { body: { tables: [{ provider: PROVIDER, fileId: 'xlsx1', sheet: 'Leveranciers', keyColumn: 0, key: 's2_bynaam' }] } }));
    assert.strictEqual(ok.statusCode, 201, JSON.stringify(ok.body));
    const id = ok.body.datatables[0].id;
    const lev = await settled(id, since);
    assert.strictEqual(lev.syncState.status, 'ok', JSON.stringify(lev.syncState));
    assert.deepStrictEqual((await realRows('s2_bynaam')).map(r => r.id), ['Acme', 'Bee']);
    const keyFieldId = lev.source.identity.keyFieldId;

    // Switching the key to Stad through the settings: the same fresh-read
    // check the link ran — without it the next pass would assign ids
    // first-occurrence-wins and silently delete the second Delft row.
    linkerCalls.length = 0;
    const moved = await call('put', '/:id/source', as(OWNER, { params: { id }, body: { keyColumn: 1 } }));
    assert.strictEqual(linkerCalls.length, 1, 'the settings-time read resolves the linker once');
    assert.strictEqual(linkerCalls[0][1].orgId, ORG, 'under the TABLE\'s org, like the pass — the tenant gates apply');
    assert.strictEqual(moved.statusCode, 422, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.code, 'key_not_unique');
    assert.match(moved.body.error, /"Stad" cannot be the key: 1 rows repeat a value \("Delft"\)/);
    // the same body the link ships: the column and the reason, for the client's sentence
    assert.strictEqual(moved.body.header, 'Stad', 'header on the wire through PUT /:id/source too');
    assert.strictEqual(moved.body.detail, '1 rows repeat a value ("Delft")');
    assert.deepStrictEqual(moved.body.ref, { provider: PROVIDER, fileId: 'xlsx1', sheet: 'Leveranciers' });
    const after = await datatableStore.getDatatable(id, SC);
    assert.strictEqual(after.source.identity.keyFieldId, keyFieldId, 'the identity did not move');
    assert.strictEqual(after.syncState.staleReason || null, null, 'no pass was kicked');
    assert.deepStrictEqual((await realRows('s2_bynaam')).map(r => r.id), ['Acme', 'Bee'], 'every row still there');

    // the same key, or row numbers, needs no read and is accepted
    assert.strictEqual((await call('put', '/:id/source', as(OWNER, { params: { id }, body: { keyColumn: 0 } }))).statusCode, 200);
    const rowMode = await call('put', '/:id/source', as(OWNER, { params: { id }, body: { keyColumn: null } }));
    assert.strictEqual(rowMode.statusCode, 200, JSON.stringify(rowMode.body));
    assert.strictEqual(rowMode.body.datatable.source.keyColumn, null);
    await call('delete', '/:id', as(OWNER, { params: { id } }));
});
