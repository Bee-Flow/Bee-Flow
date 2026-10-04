/**
 * The write-through of a spreadsheet mirror, with the storage (a fake
 * FileApi over REAL csv bytes, plus a fake cell API) and the stores stubbed:
 * a read-only file is refused before anything is probed; the file is probed
 * FIRST and a moved marker is a conflict before any write; the target row is
 * located by its key, or by its number and verified against the copy; the
 * key column edited moves the copy row to its new id; a row-mode delete
 * marks the copy stale, runs a pass and says `renumbered` — or leaves the
 * mark for a pass already running instead of taking its claim; a 412 on
 * the PUT is retried once on fresh bytes and then a conflict; the batch
 * forms are one download and one upload; derived and formula columns are
 * refused — by the map, and by the file for a formula the map does not
 * know; two writers on one file take turns; the sync state records the
 * new marker with the pass's own hash; a csv re-saved with another
 * delimiter is edited in the dialect it has now; a number key mints the
 * same id on both sides; a cell API's recalculated formula cells are read
 * back; an append that landed inside the block flags the copy behind.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/writeThrough.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');
const columns = require('./columns');
const cache = require('./cache');
const { SpreadsheetSourceError } = require('./errors');

// ── the mirror ─────────────────────────────────────────────────────────────
const SCOPE = { kind: 'org', id: 'org_1' };
const HEADER = ['Factuurnummer', 'Leverancier', 'Totaal', 'Btw'];
const SHEET_COLS = HEADER.map((h, col) => ({ col, header: h, type: col === 2 ? 'number' : 'text', formula: col === 3 }));
const derived = columns.fieldsFromSheet(SHEET_COLS, {
    keyCol: 0,
    declaredRelations: [{ targetDatatableId: 'tbl_kl', targetKey: 'klanten', targetName: 'Klanten', localFieldId: columns.fieldIdFor(columns.describeHeader(HEADER)[1].headerHash, 'text'), targetFieldId: 'fld_x' }],
});
const KEY_ID = derived.keyFieldId;
const REL_ID = derived.relations[0].fieldId;
const META = { id: 'tbl_fac', key: 'facturen', access: { default: 'app' }, fields: derived.fields };

function mirror(over = {}, sourceOver = {}) {
    return {
        id: 'tbl_fac', key: 'facturen', name: 'Facturen', scope: SCOPE, organizationId: 'org_1',
        managedKind: 'spreadsheet_file', rowScope: 'all', rowCount: 2,
        source: {
            kind: 'spreadsheet_file', provider: 'google_drive', format: 'csv',
            file: { id: 'f1', driveId: null, path: null, name: 'facturen.csv', webUrl: null },
            sheet: { id: null, name: null, index: 0 }, headerRow: 1,
            identity: { mode: 'key', keyFieldId: KEY_ID }, csv: null, owned: true,
            write: { mode: 'csv_put', reason: null, caveats: ['rewrite'], sharedOptIn: false },
            linkedByUserId: 'user_1', schedule: { everyMinutes: 1, live: true }, refreshOnView: true, rowCap: 10000,
            columnMap: derived.columnMap, relations: derived.relations,
            ...sourceOver,
        },
        syncState: { status: 'ok', lastSuccessAt: '2026-09-13T09:00:00.000Z', marker: { version: '1' }, contentHash: 'sha256:old' },
        ...over,
    };
}
const rowMirror = (over = {}, sourceOver = {}) => mirror(over, { identity: { mode: 'row' }, ...sourceOver });

// ── the fake copy: the compiled statements, replayed on a Map ──────────────
const db = { rows: new Map(), execs: [], batches: [], bumps: [] };
function colsOf(sql) { return [...sql.matchAll(/"([a-z_]+)"/g)].map(m => m[1]); }
function apply(sql, params) {
    if (/^INSERT INTO "facturen"/.test(sql)) {
        const names = colsOf(sql.slice(sql.indexOf('('), sql.indexOf(') VALUES')));
        const row = {};
        names.forEach((n, i) => { row[n] = params[i]; });
        if (db.rows.has(row.id)) throw new Error(`duplicate key ${row.id}`);
        db.rows.set(row.id, row);
        return { changes: 1 };
    }
    if (/^UPDATE "facturen"/.test(sql)) {
        const setPart = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
        const names = colsOf(setPart);
        const idAt = (sql.slice(0, sql.indexOf('WHERE "id" = ?')).match(/\?/g) || []).length;
        const id = params[idAt];
        const row = db.rows.get(id);
        if (!row) return { changes: 0 };
        names.forEach((n, i) => { row[n] = params[i]; });
        return { changes: 1 };
    }
    if (/^DELETE FROM "facturen"/.test(sql)) return { changes: db.rows.delete(params[0]) ? 1 : 0 };
    return { changes: 0 };
}
const datatableDbStore = {
    scopeKey: () => 'org:org_1',
    query: async (a, b, sql, params) => {
        if (/^SELECT \* FROM "facturen" WHERE "id" = \?/.test(sql)) { const row = db.rows.get(params[0]); return { rows: row ? [{ ...row }] : [] }; }
        return { rows: [] };
    },
    exec: async (a, b, sql, params) => { db.execs.push({ sql, params }); return apply(sql, params); },
    batch: async (a, b, stmts) => { db.batches.push(stmts.map(s => s.sql)); return stmts.map(s => apply(s.sql, s.params)); },
};

// ── the fake stores and the sync module ────────────────────────────────────
const world = { table: null, siblings: [], patches: [], stale: [], kicks: [], passes: [], running: false };
const datatableStore = {
    getDatatable: async () => world.table,
    patchSyncState: async (id, patch) => {
        world.patches.push({ id, ...JSON.parse(JSON.stringify(patch)) });
        if (id === world.table.id) world.table = { ...world.table, syncState: { ...world.table.syncState, ...patch, ...(world.running ? { status: 'running' } : {}) } };
        return id === world.table.id ? world.table : (world.siblings.find(s => s.id === id) || null);
    },
    markSourceStale: async (id, reason) => { world.stale.push([id, reason]); if (id === world.table.id) world.table = { ...world.table, syncState: { ...world.table.syncState, staleReason: reason } }; },
    bumpAfterWrite: async (id, scope, d) => { db.bumps.push(d); },
    listSourceMirrorsByRef: async () => world.siblings,
};
const sync = {
    kickStale: (t, opts) => { world.kicks.push(opts.reason); return true; },
    // A pass already running refuses the claim, as the store would.
    syncRows: async (t, opts) => { world.passes.push(opts); return world.running ? { ok: false, alreadyRunning: true } : { ok: true }; },
};

// ── the fake storage: real csv bytes, a version counter, a call log ────────
function csv(lines) { return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'); }
const file = { version: 1, buffer: null, uploads: [], failUploads: 0, calls: [] };
const FILE_REF = { provider: 'google_drive', fileId: 'f1', driveId: null, path: null, name: 'facturen.csv', format: 'csv' };
const marker = () => ({ version: String(file.version) });
const api = {
    probe: async () => { file.calls.push('probe'); return { marker: marker(), name: 'facturen.csv', size: file.buffer.length, format: 'csv', path: null, webUrl: null, owned: true, writable: true, file: FILE_REF }; },
    download: async () => { file.calls.push('download'); return { buffer: file.buffer, marker: marker() }; },
    upload: async (f, buffer, { ifMatch }) => {
        file.calls.push('upload');
        if (file.failUploads > 0) { file.failUploads -= 1; file.version += 1; throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'moved under us'); }
        if (!ifMatch || String(ifMatch.version) !== String(file.version)) throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'If-Match failed');
        file.buffer = buffer;
        file.version += 1;
        file.uploads.push({ ifMatch, text: buffer.toString('utf8') });
        return { marker: marker() };
    },
    markerEquals: (a, b) => !!a && !!b && a.version != null && String(a.version) === String(b.version),
};
world.api = api;

const restore = installResolveStub({
    '../../../../stores/datatableStore': datatableStore,
    '../../../../stores/datatableDbStore': datatableDbStore,
    '../../../../auth/datatableAccess': { gradeAtLeast: (g, min) => (g === 'owner' || g === 'editor' || min === 'viewer'), synthesizeAccess: () => ({ default: 'app' }) },
    '../mirror/relations': { buildRelationIndexes: async () => ({ relationIndexes: new Map([[REL_ID, new Map([['Acme', 'r2']])]]), labelIndexes: new Map(), warnings: [] }) },
    './linkerAuth': { resolveLinker: async () => ({ api: world.api, userId: 'user_1', session: {} }), forget: () => {} },
    './sync': sync,
});
const wt = require('./writeThrough');
test.after(() => restore());

const LINES = ['Factuurnummer;Leverancier;Totaal;Btw', 'F-1;Acme;10;2,1', 'F-2;Bee;20;4,2'];
function reset(table = mirror()) {
    cache.clear();
    world.table = table;
    Object.assign(world, { siblings: [], patches: [], stale: [], kicks: [], passes: [], running: false, api });
    file.version = 1; file.buffer = csv(LINES); file.uploads = []; file.failUploads = 0; file.calls = [];
    db.rows.clear(); db.execs.length = 0; db.batches.length = 0; db.bumps.length = 0;
    db.rows.set('F-1', { id: 'F-1', created_by: 'user_1', updated_at: '2026-09-13T09:00:00.000Z', factuurnummer: 'F-1', leverancier: 'Acme', totaal: '10', btw: '2,1', klanten_ref: 'r2' });
    db.rows.set('F-2', { id: 'F-2', created_by: 'user_1', updated_at: '2026-09-13T09:00:00.000Z', factuurnummer: 'F-2', leverancier: 'Bee', totaal: '20', btw: '4,2', klanten_ref: null });
}
const ctx = (grade = 'editor') => wt.contextOf({ table: world.table, scope: SCOPE, scopeKey: 'org:org_1', tableMeta: META, grade, viewerId: 'user_9' });
const lines = () => file.buffer.toString('utf8').split('\r\n');
test.beforeEach(() => reset());

test('a read-only file is refused with its reason before the context is checked, let alone the file probed', async () => {
    for (const [write, owned, reason] of [
        [{ mode: 'none', reason: 'ods' }, true, 'ods'],
        [{ mode: 'none', reason: 'no_permission' }, true, 'no_permission'],
        [{ mode: 'csv_put' }, false, 'not_owned'],
        [{}, true, 'not_writable'],
    ]) {
        const bare = { table: { source: { provider: 'onedrive', write, owned } } };
        for (const k of ['insertRow', 'updateRow', 'deleteRow', 'insertRows', 'updateRows', 'deleteRows']) {
            await assert.rejects(() => wt[k](bare, 'x', {}), (e) => e.status === 409 && e.code === 'spreadsheet_write_unsupported' && e.reason === reason && e.safe, `${k} ${reason}`);
        }
    }
    assert.deepStrictEqual(file.calls, []);
    // the opt-in on a shared file lets the write through to the next gate
    reset(mirror({}, { owned: false, write: { mode: 'csv_put', sharedOptIn: true } }));
    await assert.rejects(() => wt.insertRow({ table: world.table }, {}), /tableMeta with access/);
});

test('the wire: derived and formula columns refused, a bad value named, a blank key refused, system columns dropped', () => {
    const c = ctx();
    assert.throws(() => wt.toWire(c, { klanten_ref: 'r9' }), (e) => e.code === 'derived_column' && /relation/.test(e.message));
    assert.throws(() => wt.toWire(c, { btw: 1 }), (e) => e.code === 'derived_column' && /formula/.test(e.message));
    assert.throws(() => wt.toWire(c, { totaal: 'twelve' }), (e) => e.status === 422 && e.code === 'spreadsheet_rejected' && /^Totaal: "twelve" is not a number/.test(e.message));
    assert.throws(() => wt.toWire(c, { factuurnummer: '  ' }), (e) => e.status === 422 && e.code === 'key_missing');
    assert.throws(() => wt.toWire(c, { nope: 1 }), /unknown field: nope/);
    const w = wt.toWire(c, { id: 'zzz', created_at: 'x', factuurnummer: ' F-3 ', totaal: '1.234,5' });
    assert.deepStrictEqual([...w.cells.values()], [' F-3 ', 1234.5]);
    assert.deepStrictEqual(w.key, { fieldId: KEY_ID, value: ' F-3 ', id: 'F-3' });
});

test('insert (key mode, csv): probe first, one download, one guarded upload; the row lands under its key; the state records the new marker', async () => {
    const r = await wt.insertRow(ctx(), { factuurnummer: 'F-3', leverancier: 'Acme', totaal: '30' });
    assert.deepStrictEqual(file.calls, ['probe', 'download', 'upload']);
    assert.deepStrictEqual(file.uploads[0].ifMatch, { version: '1' }, 'If-Match carries the marker the bytes were read at');
    assert.deepStrictEqual(lines(), [...LINES, 'F-3;Acme;30;', ''], 'untouched lines byte-identical, the new one in the file\'s own dialect');
    assert.strictEqual(r.id, 'F-3');
    const row = db.rows.get('F-3');
    assert.strictEqual(row.leverancier, 'Acme');
    assert.strictEqual(row.totaal, 30);
    assert.strictEqual(row.klanten_ref, 'r2', 'the derived relation column is filled from the index');
    assert.strictEqual(row.created_by, 'user_9', 'the editor is created_by');
    assert.deepStrictEqual(db.bumps, [1]);
    assert.strictEqual(world.patches.length, 1);
    assert.deepStrictEqual(world.patches[0].marker, { version: '2' });
    assert.match(world.patches[0].contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(world.patches[0].lastWriteAt);
    assert.deepStrictEqual(world.stale, [], 'no pass was running: nothing to flag');
    // the bytes we put there are cached under the new marker: the next write downloads nothing
    await wt.insertRow(ctx(), { factuurnummer: 'F-4', leverancier: 'Dee' });
    assert.deepStrictEqual(file.calls.slice(3), ['probe', 'upload']);
    assert.deepStrictEqual(lines(), [...LINES, 'F-3;Acme;30;', 'F-4;Dee;;', '']);
});

test('a moved marker is a conflict BEFORE anything is written: the copy is flagged stale and a pass is kicked', async () => {
    file.version = 2;
    await assert.rejects(() => wt.insertRow(ctx(), { factuurnummer: 'F-3' }), (e) => e.status === 409 && e.code === 'spreadsheet_conflict' && e.errorClass === 'datatable_source_rejected' && e.safe);
    assert.deepStrictEqual(file.calls, ['probe']);
    assert.deepStrictEqual(world.stale, [['tbl_fac', 'conflict']]);
    assert.deepStrictEqual(world.kicks, ['conflict']);
    assert.strictEqual(db.rows.size, 2);
    assert.deepStrictEqual(db.bumps, []);
    // an update or a delete is the same, and never reaches the copy either
    await assert.rejects(() => wt.updateRow(ctx(), 'F-1', { leverancier: 'X' }, { expectedUpdatedAt: '2026-09-13T09:00:00Z' }), (e) => e.code === 'spreadsheet_conflict');
    await assert.rejects(() => wt.deleteRow(ctx(), 'F-1'), (e) => e.code === 'spreadsheet_conflict');
    assert.strictEqual(db.rows.size, 2);
    assert.strictEqual(file.uploads.length, 0);
});

test('update (key mode): the copy is probed first — stale token → no source call — then the row is located by its key and only that line changes', async () => {
    const stale = await wt.updateRow(ctx(), 'F-2', { leverancier: 'Bee Flow' }, { expectedUpdatedAt: '2000-01-01T00:00:00Z' });
    assert.strictEqual(stale.changes, 0);
    assert.strictEqual(stale.row.id, 'F-2');
    assert.deepStrictEqual(file.calls, []);
    const r = await wt.updateRow(ctx(), 'F-2', { leverancier: 'Bee Flow', totaal: 25 }, { expectedUpdatedAt: '2026-09-13T09:00:00Z' });
    assert.strictEqual(r.changes, 1);
    assert.strictEqual(r.id, undefined, 'the key did not change');
    assert.deepStrictEqual(lines(), [LINES[0], LINES[1], 'F-2;Bee Flow;25;4,2', '']);
    assert.strictEqual(db.rows.get('F-2').leverancier, 'Bee Flow');
    assert.strictEqual(db.rows.get('F-2').totaal, 25);
    assert.strictEqual(db.rows.get('F-2').btw, '4,2', 'the formula column is read back as the file holds it');
    // a row the sheet no longer has is dropped from the copy, as any source's not-found
    db.rows.set('F-7', { id: 'F-7', updated_at: 'x' });
    assert.deepStrictEqual(await wt.updateRow(ctx(), 'F-7', { leverancier: 'X' }), { changes: 0, row: null });
    assert.strictEqual(db.rows.has('F-7'), false);
    assert.strictEqual(file.uploads.length, 1);
});

test('csv_put: a formula-shaped text (a phone number, a pasted =formula) lands in the file with a `\'` prefix and in the copy — and the answer — without it', async () => {
    // A public form, an automation or a model may write this row: the file must
    // stay safe to double-click, and the mirror must show what was typed.
    const r = await wt.insertRow(ctx(), { factuurnummer: 'F-3', leverancier: '=cmd|\'/C calc\'!A0', totaal: -5 });
    assert.deepStrictEqual(lines()[3], "F-3;'=cmd|'/C calc'!A0;-5;", 'the text column prefixed, the number column bare');
    assert.strictEqual(r.row.leverancier, "=cmd|'/C calc'!A0", 'the answer shows what was written, not the prefix');
    assert.strictEqual(db.rows.get('F-3').leverancier, "=cmd|'/C calc'!A0", 'and so does the copy');
    assert.strictEqual(db.rows.get('F-3').totaal, -5);
    // the same through an update, and a key whose value is formula-shaped mints ONE id on both sides
    const u = await wt.updateRow(ctx(), 'F-3', { factuurnummer: '+31 6 1234 5678', leverancier: '-' });
    assert.deepStrictEqual(lines()[3], "'+31 6 1234 5678;'-;-5;");
    assert.strictEqual(u.row.leverancier, '-');
    assert.strictEqual(u.id, u.row.id);
    const idFromFile = require('./identity').rowIdFromKey('+31 6 1234 5678', 'text');
    assert.strictEqual(u.id, idFromFile, 'the id the write minted is the id the next pass mints from the file');
    assert.ok(db.rows.has(idFromFile));
    // an echo of what was read writes the same bytes: the prefix never doubles
    const before = file.buffer.toString('utf8');
    const echo = await wt.updateRow(ctx(), idFromFile, { leverancier: u.row.leverancier });
    assert.strictEqual(echo.changes, 1);
    assert.strictEqual(file.buffer.toString('utf8'), before, 'byte-identical after the echo');
});

test('the key column edited: the file changes, the copy row moves to the new id in one batch, the answer carries id', async () => {
    const r = await wt.updateRow(ctx(), 'F-2', { factuurnummer: 'F-9', leverancier: 'Cee' });
    assert.strictEqual(r.changes, 1);
    assert.strictEqual(r.id, 'F-9');
    assert.strictEqual(r.row.id, 'F-9');
    assert.strictEqual(r.row.leverancier, 'Cee');
    assert.strictEqual(r.row.created_by, 'user_1', 'the original author is kept');
    assert.deepStrictEqual(lines()[2], 'F-9;Cee;20;4,2');
    assert.deepStrictEqual([...db.rows.keys()], ['F-1', 'F-9']);
    const move = db.batches.find(b => b.length === 2 && /^DELETE/.test(b[0]) && /^INSERT/.test(b[1]));
    assert.ok(move, 'delete old + insert new in ONE batch');
    // a key another row already has is refused, and nothing is written
    await assert.rejects(() => wt.updateRow(ctx(), 'F-1', { factuurnummer: 'F-9' }), (e) => e.status === 409 && e.code === 'key_duplicate');
    await assert.rejects(() => wt.insertRow(ctx(), { factuurnummer: 'F-1' }), (e) => e.code === 'key_duplicate');
    assert.strictEqual(file.uploads.length, 1);
});

test('row mode: the row is found by its number and VERIFIED against the copy — a mismatch is a conflict, a match is written', async () => {
    reset(rowMirror());
    db.rows.clear();
    db.rows.set('r2', { id: 'r2', updated_at: 'x', factuurnummer: 'F-1', leverancier: 'Acme', totaal: '10', btw: '2,1' });
    db.rows.set('r3', { id: 'r3', updated_at: 'x', factuurnummer: 'F-2', leverancier: 'SOMEONE ELSE', totaal: '20', btw: '4,2' });
    await assert.rejects(() => wt.updateRow(ctx(), 'r3', { totaal: 1 }), (e) => e.code === 'spreadsheet_conflict' && /Row 3 of the sheet/.test(e.message));
    assert.deepStrictEqual(world.stale, [['tbl_fac', 'conflict']]);
    assert.strictEqual(file.uploads.length, 0);
    const r = await wt.updateRow(ctx(), 'r2', { totaal: 11 });
    assert.strictEqual(r.changes, 1);
    assert.deepStrictEqual(lines()[1], 'F-1;Acme;11;2,1');
    assert.strictEqual(db.rows.get('r2').totaal, 11);
    // an insert in row mode lands under the row it was appended at
    const ins = await wt.insertRow(ctx(), { factuurnummer: 'F-3', leverancier: 'Cee' });
    assert.strictEqual(ins.id, 'r4');
    assert.deepStrictEqual(world.passes, [], 'an append shifts nothing: no forced pass');
});

test('a row-mode delete removes the line, marks the copy stale, runs a pass and says renumbered; a key-mode delete does not', async () => {
    reset(rowMirror());
    db.rows.clear();
    db.rows.set('r2', { id: 'r2', updated_at: 'x', factuurnummer: 'F-1', leverancier: 'Acme', totaal: '10', btw: '2,1' });
    db.rows.set('r3', { id: 'r3', updated_at: 'x', factuurnummer: 'F-2', leverancier: 'Bee', totaal: '20', btw: '4,2' });
    const r = await wt.deleteRow(ctx(), 'r2');
    assert.deepStrictEqual(r, { changes: 1, renumbered: true });
    assert.deepStrictEqual(lines(), [LINES[0], LINES[2], '']);
    assert.strictEqual(db.rows.has('r2'), false);
    // the mark is what makes the pass read past the marker record() just
    // wrote; the pass is never forced (a forced claim steals a running one)
    assert.deepStrictEqual(world.stale, [['tbl_fac', 'write']]);
    assert.deepStrictEqual(world.passes, [{ reason: 'write' }]);
    assert.ok(world.passes.every(p => !p.force), 'no claim takeover');
    assert.deepStrictEqual(db.bumps, [-1]);

    reset();
    const k = await wt.deleteRow(ctx(), 'F-1');
    assert.deepStrictEqual(k, { changes: 1 });
    assert.deepStrictEqual(lines(), [LINES[0], LINES[2], '']);
    assert.deepStrictEqual(world.passes, []);
    // gone at the source already: counts as deleted
    db.rows.set('F-8', { id: 'F-8' });
    assert.deepStrictEqual(await wt.deleteRow(ctx(), 'F-8'), { changes: 1 });
    assert.strictEqual(file.uploads.length, 1);
});

test('a 412 on the PUT is retried ONCE on fresh bytes (the copy is then flagged behind); a second 412 is a conflict', async () => {
    file.failUploads = 1;
    const r = await wt.insertRow(ctx(), { factuurnummer: 'F-3', leverancier: 'Cee' });
    assert.strictEqual(r.id, 'F-3');
    assert.deepStrictEqual(file.calls, ['probe', 'download', 'upload', 'probe', 'download', 'upload']);
    assert.deepStrictEqual(file.uploads[0].ifMatch, { version: '2' }, 'the retry carries the fresh marker');
    assert.deepStrictEqual(world.stale, [['tbl_fac', 'write']], 'someone else changed the file: the copy may be behind');
    assert.deepStrictEqual(world.kicks, ['write']);
    assert.deepStrictEqual(world.patches[0].marker, { version: '3' });

    reset();
    file.failUploads = 2;
    await assert.rejects(() => wt.insertRow(ctx(), { factuurnummer: 'F-3' }), (e) => e.code === 'spreadsheet_conflict');
    assert.deepStrictEqual(file.calls, ['probe', 'download', 'upload', 'probe', 'download', 'upload']);
    assert.deepStrictEqual(world.stale, [['tbl_fac', 'conflict']]);
    assert.strictEqual(db.rows.size, 2);
});

test('the batch forms are ONE download and ONE upload for the whole list; a refusal in the list leaves the file untouched', async () => {
    const ins = await wt.insertRows(ctx(), [{ factuurnummer: 'F-3', leverancier: 'Cee' }, { totaal: 'nan' }, { factuurnummer: 'F-4', leverancier: 'Dee', totaal: 4 }], { collect: true });
    assert.deepStrictEqual(ins.inserted.map(r => [r.index, r.id]), [[0, 'F-3'], [2, 'F-4']]);
    assert.deepStrictEqual(ins.errors.map(e => [e.index, e.error.code]), [[1, 'spreadsheet_rejected']]);
    assert.deepStrictEqual(file.calls, ['probe', 'download', 'upload']);
    assert.deepStrictEqual(lines(), [...LINES, 'F-3;Cee;;', 'F-4;Dee;4;', '']);
    assert.deepStrictEqual(db.bumps, [2]);
    assert.strictEqual(db.rows.size, 4);

    file.calls.length = 0;
    cache.clear();
    const upd = await wt.updateRows(ctx(), [
        { id: 'F-1', values: { totaal: 100 } },
        { id: 'F-4', values: { factuurnummer: 'F-5' } },
        { id: 'nope', values: { totaal: 1 } },
        { id: 'F-3', values: { totaal: 0 }, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
    ]);
    assert.deepStrictEqual(file.calls, ['probe', 'download', 'upload']);
    assert.strictEqual(upd.changed, 2);
    assert.deepStrictEqual(upd.results.map(r => [r.index, r.changes, r.id || null]), [[0, 1, null], [1, 1, 'F-5'], [2, 0, null], [3, 0, null]]);
    assert.deepStrictEqual(lines(), [LINES[0], 'F-1;Acme;100;2,1', LINES[2], 'F-3;Cee;;', 'F-5;Dee;4;', '']);
    assert.deepStrictEqual([...db.rows.keys()].sort(), ['F-1', 'F-2', 'F-3', 'F-5']);

    file.calls.length = 0;
    cache.clear();
    const del = await wt.deleteRows(ctx(), ['F-1', 'F-5', 'nope']);
    assert.deepStrictEqual(file.calls, ['probe', 'download', 'upload']);
    assert.strictEqual(del.changed, 2);
    assert.strictEqual(del.renumbered, undefined);
    assert.deepStrictEqual(lines(), [LINES[0], LINES[2], 'F-3;Cee;;', '']);
    // a duplicate key inside one import is the whole batch's refusal, and nothing is written
    file.calls.length = 0;
    cache.clear();
    await assert.rejects(() => wt.insertRows(ctx(), [{ factuurnummer: 'F-6' }, { factuurnummer: 'F-6' }]), (e) => e.code === 'key_duplicate');
    assert.deepStrictEqual(file.calls, ['probe', 'download']);
});

test('a pass running while we write: the new marker is recorded AND the copy is flagged behind for that pass', async () => {
    world.running = true;
    await wt.insertRow(ctx(), { factuurnummer: 'F-3' });
    assert.deepStrictEqual(world.patches[0].marker, { version: '2' });
    assert.deepStrictEqual(world.stale, [['tbl_fac', 'write']]);
    assert.deepStrictEqual(world.kicks, [], 'the running pass finishes and keeps the mark; no second kick');
});

test('sibling mirrors of the same file (other tabs) follow the marker only when they were at the one we verified', async () => {
    world.siblings = [
        { id: 'tbl_other_tab', syncState: { marker: { version: '1' } } },
        { id: 'tbl_behind', syncState: { marker: { version: '0' } } },
        { id: 'tbl_fac', syncState: { marker: { version: '1' } } },
    ];
    await wt.insertRow(ctx(), { factuurnummer: 'F-3' });
    assert.deepStrictEqual(world.patches.map(p => [p.id, p.marker.version, 'contentHash' in p]), [['tbl_fac', '2', true], ['tbl_other_tab', '2', false]]);
});

test('two writers on one file take turns: the second reads what the first wrote', async () => {
    const [a, b] = await Promise.all([
        wt.insertRow(ctx(), { factuurnummer: 'F-3', leverancier: 'A' }),
        wt.insertRow(ctx(), { factuurnummer: 'F-4', leverancier: 'B' }),
    ]);
    assert.deepStrictEqual([a.id, b.id], ['F-3', 'F-4']);
    assert.deepStrictEqual(file.calls, ['probe', 'download', 'upload', 'probe', 'upload'], 'the second waited, then read the first\'s bytes from the cache');
    assert.deepStrictEqual(lines(), [...LINES, 'F-3;A;;', 'F-4;B;;', '']);
    assert.strictEqual(cache.stats().locks, 0);
});

test('sheets_api: typed cells with dates as serials, the marker chained across a batch, an append under its key, a row-mode delete renumbered', async () => {
    const DHEADER = ['Nr', 'Datum', 'Bedrag'];
    const dcols = columns.fieldsFromSheet(DHEADER.map((h, col) => ({ col, header: h, type: ['text', 'date', 'number'][col] })), { keyCol: 0 });
    const DMETA = { id: 'tbl_fac', key: 'facturen', access: { default: 'app' }, fields: dcols.fields };
    const sheet = { version: 1, rows: [DHEADER, ['A-1', 46000, 10], ['A-2', 46001, 20]], calls: [] };
    const sMarker = () => ({ version: String(sheet.version) });
    const cells = {
        available: async () => true,
        listSheets: async () => [{ id: 7, name: 'Blad1', index: 0, rowCount: 100, colCount: 3, hidden: false }],
        readSheet: async () => { sheet.calls.push('readSheet'); return { rows: sheet.rows.map(r => [...r]), errorCells: 0 }; },
        sample: async () => ({ rows: sheet.rows.map(r => [...r]), numberFormat: new Map([[1, 'DATE']]), formulaCols: new Set() }),
        updateCells: async (f, s, row, list, { ifMatch }) => {
            sheet.calls.push(['updateCells', s.id, row, list, ifMatch.version]);
            if (String(ifMatch.version) !== String(sheet.version)) throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'moved');
            for (const c of list) sheet.rows[row - 1][c.col] = c.value;
            sheet.version += 1;
            return { marker: sMarker() };
        },
        appendRow: async (f, s, list, { ifMatch, afterRow }) => {
            sheet.calls.push(['appendRow', s.id, list, ifMatch.version, afterRow]);
            if (String(ifMatch.version) !== String(sheet.version)) throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'moved');
            const row = new Array(3).fill(null);
            for (const c of list) row[c.col] = c.value;
            sheet.rows.push(row);
            sheet.version += 1;
            return { rowNumber: sheet.rows.length, marker: sMarker() };
        },
        deleteRow: async (f, s, row, { ifMatch }) => {
            sheet.calls.push(['deleteRow', s.id, row, ifMatch.version]);
            if (String(ifMatch.version) !== String(sheet.version)) throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'moved');
            sheet.rows.splice(row - 1, 1);
            sheet.version += 1;
            return { marker: sMarker() };
        },
    };
    const gapi = {
        probe: async () => { sheet.calls.push('probe'); return { marker: sMarker(), name: 'Facturen', size: null, format: 'gsheet', path: null, webUrl: null, owned: true, writable: true, file: { provider: 'google_drive', fileId: 'g1', format: 'gsheet', name: 'Facturen' } }; },
        download: async () => { throw new Error('a native Sheet has no bytes'); },
        upload: async () => { throw new Error('a native Sheet is not uploaded'); },
        markerEquals: api.markerEquals,
        cells,
    };
    const gtable = mirror({ syncState: { status: 'ok', marker: { version: '1' } } }, {
        format: 'gsheet', file: { id: 'g1', name: 'Facturen' }, sheet: { id: 7, name: 'Blad1', index: 0 },
        identity: { mode: 'key', keyFieldId: dcols.keyFieldId }, write: { mode: 'sheets_api', reason: null, caveats: [], sharedOptIn: false },
        columnMap: dcols.columnMap, relations: [],
    });
    reset(gtable);
    world.api = gapi;
    db.rows.clear();
    db.rows.set('A-1', { id: 'A-1', updated_at: 'x', nr: 'A-1', datum: new Date('2025-12-09T00:00:00Z'), bedrag: '10' });
    db.rows.set('A-2', { id: 'A-2', updated_at: 'x', nr: 'A-2', datum: new Date('2025-12-10T00:00:00Z'), bedrag: '20' });
    const c = () => wt.contextOf({ table: world.table, scope: SCOPE, scopeKey: 'org:org_1', tableMeta: DMETA, grade: 'editor', viewerId: 'user_9' });

    const upd = await wt.updateRows(c(), [{ id: 'A-1', values: { datum: '2026-01-15', bedrag: 11 } }, { id: 'A-2', values: { bedrag: 22 } }]);
    assert.strictEqual(upd.changed, 2);
    assert.deepStrictEqual(sheet.calls.filter(x => Array.isArray(x)), [
        ['updateCells', 7, 2, [{ col: 1, value: 46037, type: 'date' }, { col: 2, value: 11, type: 'number' }], '1'],
        ['updateCells', 7, 3, [{ col: 2, value: 22, type: 'number' }], '2'],
    ], 'dates go as serials, the marker of one write guards the next');
    assert.strictEqual(db.rows.get('A-1').datum, '2026-01-15');
    assert.strictEqual(db.rows.get('A-1').bedrag, 11);
    assert.deepStrictEqual(world.patches[0].marker, { version: '3' });
    assert.strictEqual(sheet.calls.filter(x => x === 'readSheet').length, 1, 'one read for the whole batch');

    sheet.calls.length = 0;
    const ins = await wt.insertRow(c(), { nr: 'A-3', datum: '2026-02-01' });
    assert.strictEqual(ins.id, 'A-3');
    assert.deepStrictEqual(sheet.calls.filter(x => Array.isArray(x)), [['appendRow', 7, [{ col: 0, value: 'A-3', type: 'text' }, { col: 1, value: 46054, type: 'date' }], '3', 3]]);
    assert.strictEqual(db.rows.get('A-3').datum, '2026-02-01');

    // row mode on the same sheet: a delete renumbers
    reset(mirror({ syncState: { status: 'ok', marker: sMarker() } }, { ...gtable.source, identity: { mode: 'row' } }));
    world.api = gapi;
    db.rows.clear();
    db.rows.set('r2', { id: 'r2', updated_at: 'x', nr: 'A-1', datum: new Date('2026-01-15T00:00:00Z'), bedrag: '11' });
    sheet.calls.length = 0;
    const del = await wt.deleteRow(c(), 'r2');
    assert.deepStrictEqual(del, { changes: 1, renumbered: true });
    assert.deepStrictEqual(sheet.calls.filter(x => Array.isArray(x)), [['deleteRow', 7, 2, '4']]);
    assert.deepStrictEqual(sheet.rows[1], ['A-2', 46001, 22]);
    assert.deepStrictEqual(world.passes, [{ reason: 'write' }]);
    assert.deepStrictEqual(world.stale, [['tbl_fac', 'write']]);
});

test('a row-mode delete while a pass is running does NOT take its claim: the mark stays, a kick is scheduled, the answer says renumbered: false', async () => {
    reset(rowMirror());
    world.running = true;
    db.rows.clear();
    db.rows.set('r2', { id: 'r2', updated_at: 'x', factuurnummer: 'F-1', leverancier: 'Acme', totaal: '10', btw: '2,1' });
    db.rows.set('r3', { id: 'r3', updated_at: 'x', factuurnummer: 'F-2', leverancier: 'Bee', totaal: '20', btw: '4,2' });
    const r = await wt.deleteRow(ctx(), 'r2');
    assert.deepStrictEqual(r, { changes: 1, renumbered: false }, 'the pass in flight renumbers shortly');
    assert.deepStrictEqual(lines(), [LINES[0], LINES[2], ''], 'the file and the copy row are written all the same');
    assert.strictEqual(db.rows.has('r2'), false);
    assert.deepStrictEqual(world.passes, [{ reason: 'write' }], 'asked once, without force — the running claim was not taken over');
    assert.ok(world.stale.some(([id, why]) => id === 'tbl_fac' && why === 'write'), 'the mark the finishing pass keeps');
    assert.ok(world.kicks.includes('write'), 'a kick for the moment that pass is done');
    assert.strictEqual(world.table.syncState.staleReason, 'write');

    // the batch form, the same
    reset(rowMirror());
    world.running = true;
    db.rows.clear();
    db.rows.set('r2', { id: 'r2', updated_at: 'x', factuurnummer: 'F-1', leverancier: 'Acme', totaal: '10', btw: '2,1' });
    const out = await wt.deleteRows(ctx(), ['r2']);
    assert.strictEqual(out.changed, 1);
    assert.strictEqual(out.renumbered, false);
    assert.deepStrictEqual(world.passes, [{ reason: 'write' }]);
});

test('record(): the hash a write records is the hash the pass computes — row numbers included in row mode, not in key mode', async () => {
    const reading = require('./reading');
    const formats = require('./formats');
    const passHash = async (rowNumbers) => {
        const read = await formats.readSheet(file.buffer, { format: 'csv', headerRow: 1 });
        return reading.contentHashOf(read.header, read.rows, rowNumbers ? read.rowNumbers : null);
    };
    // key mode: the plain hash (a row-number shift is nothing to a copy keyed by value)
    await wt.insertRow(ctx(), { factuurnummer: 'F-3', leverancier: 'Cee' });
    assert.strictEqual(world.patches[0].contentHash, await passHash(false));
    assert.notStrictEqual(world.patches[0].contentHash, await passHash(true));

    // row mode: the row numbers are part of it — after a write the next
    // pass over a moved marker must still read "unchanged"
    reset(rowMirror());
    db.rows.clear();
    db.rows.set('r2', { id: 'r2', updated_at: 'x', factuurnummer: 'F-1', leverancier: 'Acme', totaal: '10', btw: '2,1' });
    await wt.updateRow(ctx(), 'r2', { totaal: 11 });
    assert.strictEqual(world.patches[0].contentHash, await passHash(true));
    assert.notStrictEqual(world.patches[0].contentHash, await passHash(false));
});

test('csv re-saved with another delimiter since it was linked: the row is edited in the dialect the file has NOW, every other column kept', async () => {
    // linked when it was ';'-separated with decimal commas; the owner re-saved it with ',' and '.'
    reset(mirror({}, { csv: { delimiter: ';', quote: '"', bom: false, eol: '\r\n', encoding: 'utf-8', decimal: ',' } }));
    const US = ['Factuurnummer,Leverancier,Totaal,Btw', 'F-1,Acme,10,2.1', 'F-2,Bee,20,4.2'];
    file.buffer = csv(US);
    const r = await wt.updateRow(ctx(), 'F-2', { totaal: 25.5 });
    assert.strictEqual(r.changes, 1);
    assert.deepStrictEqual(lines(), [US[0], US[1], 'F-2,Bee,25.5,4.2', ''], 'the sniffed delimiter and decimal, not the stored ones');
    assert.strictEqual(db.rows.get('F-2').totaal, 25.5);
    // the key column, whose edit used to rewrite the line as ONE field
    const k = await wt.updateRow(ctx(), 'F-2', { factuurnummer: 'F-9' });
    assert.strictEqual(k.id, 'F-9');
    assert.deepStrictEqual(lines(), [US[0], US[1], 'F-9,Bee,25.5,4.2', '']);
    const a = await wt.insertRow(ctx(), { factuurnummer: 'F-3', leverancier: 'Cee', totaal: 7 });
    assert.strictEqual(a.id, 'F-3');
    assert.deepStrictEqual(lines(), [US[0], US[1], 'F-9,Bee,25.5,4.2', 'F-3,Cee,7,', '']);
});

test('a number key mints the same id on both sides whatever the file spells: 7,5 in a decimal-comma csv is the row 7.5 written from Bee Flow', async () => {
    const NHEADER = ['Nr', 'Naam'];
    const ncols = columns.fieldsFromSheet(NHEADER.map((h, col) => ({ col, header: h, type: col === 0 ? 'number' : 'text' })), { keyCol: 0 });
    const NMETA = { id: 'tbl_fac', key: 'facturen', access: { default: 'app' }, fields: ncols.fields };
    reset(mirror({}, { identity: { mode: 'key', keyFieldId: ncols.keyFieldId }, columnMap: ncols.columnMap, relations: [], csv: { delimiter: ';', decimal: ',' } }));
    const NL = ['Nr;Naam', '7,5;Acme', '1.000;Bee'];
    file.buffer = csv(NL);
    db.rows.clear();
    db.rows.set('7.5', { id: '7.5', updated_at: 'x', nr: '7.5', naam: 'Acme' });
    db.rows.set('1000', { id: '1000', updated_at: 'x', nr: '1000', naam: 'Bee' });
    const c = () => wt.contextOf({ table: world.table, scope: SCOPE, scopeKey: 'org:org_1', tableMeta: NMETA, grade: 'editor', viewerId: 'user_9' });
    // the rows the file holds are found under the canonical number
    const u = await wt.updateRow(c(), '7.5', { naam: 'Acme BV' });
    assert.strictEqual(u.changes, 1);
    assert.deepStrictEqual(lines(), [NL[0], '7,5;Acme BV', NL[2], '']);
    const v = await wt.updateRow(c(), '1000', { naam: 'Bee BV' });
    assert.strictEqual(v.changes, 1);
    // a row inserted with 8.25 is spelled 8,25 in the file and answered — and found again — as '8.25'
    const ins = await wt.insertRow(c(), { nr: 8.25, naam: 'Cee' });
    assert.strictEqual(ins.id, '8.25');
    assert.deepStrictEqual(lines()[3], '8,25;Cee');
    const again = await wt.updateRow(c(), '8.25', { naam: 'Cee BV' });
    assert.strictEqual(again.changes, 1, 'the id the write answered is the id the read mints');
    assert.deepStrictEqual(lines()[3], '8,25;Cee BV');
    // the same number in another spelling is a duplicate, not a second row
    await assert.rejects(() => wt.insertRow(c(), { nr: '7.50' }), (e) => e.code === 'key_duplicate');
    await assert.rejects(() => wt.insertRow(c(), { nr: 'abc' }), (e) => e.code === 'spreadsheet_rejected');
});

function cellsSheetApi(sheet, { withReadRow = true, appendAt = null } = {}) {
    const sMarker = () => ({ version: String(sheet.version) });
    const recompute = (row) => { if (sheet.recalc) sheet.recalc(row); };
    const cells = {
        available: async () => true,
        listSheets: async () => [{ id: 7, name: 'Blad1', index: 0, rowCount: 100, colCount: 3, hidden: false }],
        readSheet: async () => { sheet.calls.push('readSheet'); return { rows: sheet.rows.map(r => [...r]), errorCells: 0 }; },
        sample: async () => ({ rows: sheet.rows.map(r => [...r]), numberFormat: new Map(), formulaCols: sheet.formulaCols || new Set() }),
        updateCells: async (f, s, row, list, { ifMatch }) => {
            sheet.calls.push(['updateCells', row, list]);
            if (String(ifMatch.version) !== String(sheet.version)) throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'moved');
            for (const c of list) sheet.rows[row - 1][c.col] = c.value;
            recompute(sheet.rows[row - 1]);
            sheet.version += 1;
            return { marker: sMarker() };
        },
        appendRow: async (f, s, list, { ifMatch, afterRow }) => {
            sheet.calls.push(['appendRow', list, afterRow]);
            if (String(ifMatch.version) !== String(sheet.version)) throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'moved');
            const row = new Array(3).fill(null);
            for (const c of list) row[c.col] = c.value;
            recompute(row);
            let rowNumber;
            if (appendAt) { sheet.rows.splice(appendAt - 1, 0, row); rowNumber = appendAt; }   // a provider that ignored afterRow: lands in a gap
            else { sheet.rows.push(row); rowNumber = sheet.rows.length; }
            sheet.version += 1;
            return { rowNumber, marker: sMarker() };
        },
        deleteRow: async (f, s, row, { ifMatch }) => {
            if (String(ifMatch.version) !== String(sheet.version)) throw new SpreadsheetSourceError(409, 'spreadsheet_conflict', 'moved');
            sheet.rows.splice(row - 1, 1);
            sheet.version += 1;
            return { marker: sMarker() };
        },
    };
    if (withReadRow) cells.readRow = async (f, s, n) => { sheet.calls.push(['readRow', n]); return [...(sheet.rows[n - 1] || [])]; };
    return {
        probe: async () => { sheet.calls.push('probe'); return { marker: sMarker(), name: 'Facturen', size: null, format: 'gsheet', path: null, webUrl: null, owned: true, writable: true, file: { provider: 'google_drive', fileId: 'g1', format: 'gsheet', name: 'Facturen' } }; },
        download: async () => { throw new Error('a native Sheet has no bytes'); },
        upload: async () => { throw new Error('a native Sheet is not uploaded'); },
        markerEquals: api.markerEquals,
        cells,
    };
}

test('sheets_api with a formula column: the rows written are read back so the copy holds what the sheet now computes; without readRow the copy is flagged behind', async () => {
    const FHEADER = ['Nr', 'Bedrag', 'Totaal'];
    const fcols = columns.fieldsFromSheet(FHEADER.map((h, col) => ({ col, header: h, type: col === 0 ? 'text' : 'number', formula: col === 2 })), { keyCol: 0 });
    const FMETA = { id: 'tbl_fac', key: 'facturen', access: { default: 'app' }, fields: fcols.fields };
    const make = () => ({ version: 1, rows: [FHEADER, ['A-1', 100, 121], ['A-2', 50, 60.5]], calls: [], formulaCols: new Set([2]), recalc: (row) => { row[2] = Math.round(row[1] * 121) / 100; } });
    const table = (sMarker) => mirror({ syncState: { status: 'ok', marker: sMarker } }, {
        format: 'gsheet', file: { id: 'g1', name: 'Facturen' }, sheet: { id: 7, name: 'Blad1', index: 0 },
        identity: { mode: 'key', keyFieldId: fcols.keyFieldId }, write: { mode: 'sheets_api', reason: null, caveats: [], sharedOptIn: false },
        columnMap: fcols.columnMap, relations: [],
    });
    const c = () => wt.contextOf({ table: world.table, scope: SCOPE, scopeKey: 'org:org_1', tableMeta: FMETA, grade: 'editor', viewerId: 'user_9' });

    let sheet = make();
    reset(table({ version: '1' }));
    world.api = cellsSheetApi(sheet);
    db.rows.clear();
    db.rows.set('A-1', { id: 'A-1', updated_at: 'x', nr: 'A-1', bedrag: '100', totaal: '121' });
    const r = await wt.updateRow(c(), 'A-1', { bedrag: 200 });
    assert.strictEqual(r.changes, 1);
    assert.deepStrictEqual(sheet.calls.filter(x => Array.isArray(x)), [['updateCells', 2, [{ col: 1, value: 200, type: 'number' }]], ['readRow', 2]], 'the written row read back, once');
    assert.strictEqual(db.rows.get('A-1').bedrag, 200);
    assert.strictEqual(db.rows.get('A-1').totaal, 242, 'the recalculated formula cell, not the cached 121');
    assert.strictEqual(r.row.totaal, 242);
    assert.deepStrictEqual(world.stale, [], 'read back: nothing to flag');
    const ins = await wt.insertRow(c(), { nr: 'A-3', bedrag: 10 });
    assert.strictEqual(db.rows.get('A-3').totaal, 12.1, 'an appended row too');
    assert.strictEqual(ins.row.totaal, 12.1);

    // a cell API without readRow: the copy keeps the cached result for now and is flagged for the next pass
    sheet = make();
    reset(table({ version: '1' }));
    world.api = cellsSheetApi(sheet, { withReadRow: false });
    db.rows.clear();
    db.rows.set('A-1', { id: 'A-1', updated_at: 'x', nr: 'A-1', bedrag: '100', totaal: '121' });
    await wt.updateRow(c(), 'A-1', { bedrag: 200 });
    assert.strictEqual(db.rows.get('A-1').totaal, 121);
    assert.deepStrictEqual(world.stale, [['tbl_fac', 'write']]);
    assert.deepStrictEqual(world.kicks, ['write']);
    assert.deepStrictEqual(world.patches[0].marker, { version: '2' });

    // no formula column: no read-back, no flag
    sheet = make();
    sheet.formulaCols = new Set();
    reset(table({ version: '1' }));
    world.api = cellsSheetApi(sheet);
    db.rows.clear();
    db.rows.set('A-1', { id: 'A-1', updated_at: 'x', nr: 'A-1', bedrag: '100', totaal: '121' });
    await wt.updateRow(c(), 'A-1', { bedrag: 200 });
    assert.strictEqual(sheet.calls.some(x => Array.isArray(x) && x[0] === 'readRow'), false);
    assert.deepStrictEqual(world.stale, []);
});

test('an append a cell API lands INSIDE the block (rows under it shifted) flags the copy behind for the next pass', async () => {
    const DHEADER = ['Nr', 'Datum', 'Bedrag'];
    const dcols = columns.fieldsFromSheet(DHEADER.map((h, col) => ({ col, header: h, type: ['text', 'date', 'number'][col] })), { keyCol: 0 });
    const DMETA = { id: 'tbl_fac', key: 'facturen', access: { default: 'app' }, fields: dcols.fields };
    const sheet = { version: 1, rows: [DHEADER, ['A-1', 46000, 10], ['A-2', 46001, 20]], calls: [] };
    reset(mirror({ syncState: { status: 'ok', marker: { version: '1' } } }, {
        format: 'gsheet', file: { id: 'g1', name: 'Facturen' }, sheet: { id: 7, name: 'Blad1', index: 0 },
        identity: { mode: 'key', keyFieldId: dcols.keyFieldId }, write: { mode: 'sheets_api', reason: null, caveats: [], sharedOptIn: false },
        columnMap: dcols.columnMap, relations: [],
    }));
    world.api = cellsSheetApi(sheet, { appendAt: 2 });
    db.rows.clear();
    const c = () => wt.contextOf({ table: world.table, scope: SCOPE, scopeKey: 'org:org_1', tableMeta: DMETA, grade: 'editor', viewerId: 'user_9' });
    const ins = await wt.insertRow(c(), { nr: 'A-3', bedrag: 30 });
    assert.strictEqual(ins.id, 'A-3');
    assert.deepStrictEqual(sheet.calls.filter(x => Array.isArray(x)), [['appendRow', [{ col: 0, value: 'A-3', type: 'text' }, { col: 2, value: 30, type: 'number' }], 3]], 'afterRow was handed to the provider');
    assert.deepStrictEqual(world.stale, [['tbl_fac', 'write']], 'the in-memory post state cannot model the shift: a pass re-reads');
    assert.deepStrictEqual(world.kicks, ['write']);
    assert.deepStrictEqual(world.patches[0].marker, { version: '2' });
});

test('exceljs: a formula in a cell the column map does not know (added since the last pass) refuses the write BEFORE the upload, naming the column', async () => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Facturen');
    ws.addRow(HEADER);
    ws.addRow(['F-1', 'Acme', 10, { formula: 'C2*0.21', result: 2.1 }]);
    ws.addRow(['F-2', 'Bee', 20, { formula: 'C3*0.21', result: 4.2 }]);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    // the map as the last pass left it: Btw a plain number column
    const plain = columns.fieldsFromSheet(HEADER.map((h, col) => ({ col, header: h, type: col >= 2 ? 'number' : 'text' })), { keyCol: 0 });
    const PMETA = { id: 'tbl_fac', key: 'facturen', access: { default: 'app' }, fields: plain.fields };
    reset(mirror({}, {
        format: 'xlsx', file: { id: 'x1', name: 'facturen.xlsx' }, sheet: { id: null, name: 'Facturen', index: 0 },
        identity: { mode: 'key', keyFieldId: plain.keyFieldId }, write: { mode: 'exceljs_put', reason: null, caveats: ['charts', 'pivots', 'vba', 'slicers'], sharedOptIn: false },
        columnMap: plain.columnMap, relations: [],
    }));
    const XREF = { provider: 'google_drive', fileId: 'x1', driveId: null, path: null, name: 'facturen.xlsx', format: 'xlsx' };
    world.api = {
        ...api,
        probe: async () => { file.calls.push('probe'); return { marker: marker(), name: 'facturen.xlsx', size: xlsx.length, format: 'xlsx', path: null, webUrl: null, owned: true, writable: true, file: XREF }; },
        download: async () => { file.calls.push('download'); return { buffer: xlsx, marker: marker() }; },
    };
    const c = () => wt.contextOf({ table: world.table, scope: SCOPE, scopeKey: 'org:org_1', tableMeta: PMETA, grade: 'editor', viewerId: 'user_9' });
    db.rows.clear();
    db.rows.set('F-1', { id: 'F-1', updated_at: 'x', factuurnummer: 'F-1', leverancier: 'Acme', totaal: '10', btw: '2.1' });
    await assert.rejects(() => wt.updateRow(c(), 'F-1', { leverancier: 'Acme BV', btw: 3 }), (e) => e.status === 400 && e.code === 'derived_column' && /"Btw" holds a formula in the file/.test(e.message) && e.safe);
    assert.deepStrictEqual(file.calls, ['probe', 'download'], 'nothing was uploaded');
    assert.strictEqual(db.rows.get('F-1').leverancier, 'Acme', 'and the copy is as it was — the other cell of the same op was not written either');
    assert.deepStrictEqual(world.patches, []);
});

test('sameValue: what the copy holds against what the sheet reads, per type', () => {
    assert.strictEqual(wt.sameValue('10', 10, 'number'), true);
    assert.strictEqual(wt.sameValue(null, '', 'text'), true);
    assert.strictEqual(wt.sameValue('a', 'b', 'text'), false);
    assert.strictEqual(wt.sameValue(true, true, 'bool'), true);
    assert.strictEqual(wt.sameValue('t', false, 'bool'), false);
    assert.strictEqual(wt.sameValue(new Date('2026-01-15T00:00:00Z'), '2026-01-15', 'date'), true);
    // node-postgres hands a DATE back as `new Date(y, m, d)` — midnight in the
    // PROCESS's zone, so the instant differs per zone (23:00Z the day before in
    // CET, 00:00Z under TZ=UTC). Build the fixture the way the driver does;
    // spelling the instant out only encoded one zone's answer.
    assert.strictEqual(wt.sameValue(new Date(2026, 0, 16), '2026-01-16', 'date'), true, 'a pg DATE at local midnight still names the day');
    assert.strictEqual(wt.sameValue(new Date('2026-01-15T10:00:00.000Z'), '2026-01-15T10:00:00.000Z', 'datetime'), true);
    assert.strictEqual(wt.sameValue(new Date('2026-01-15T10:00:00.000Z'), '2026-01-15T11:00:00.000Z', 'datetime'), false);
});
