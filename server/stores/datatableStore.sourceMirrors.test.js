'use strict';

/**
 * The store's mirror functions, against a REAL Postgres, for BOTH kinds.
 *
 * What is pinned here is SQL that a regex cannot judge:
 *   • the claim/finish/due cycle works for a spreadsheet mirror exactly as
 *     for a Nextcloud one — the WHERE says `managed_kind IN (…)`, spelled
 *     out, so the partial indexes match;
 *   • finishSourceSync keeps a `staleReason` that was set AFTER the claim
 *     (a write-through or a push event landing mid-pass) — the CASE with the
 *     two ::timestamptz casts — and clears one set before it;
 *   • patchSyncState never touches a running claim;
 *   • the three new lookups (by file ref, by path, by linker) narrow as
 *     documented, and listSourceMirrorsInScope answers all kinds unless
 *     asked for one;
 *   • the one-release aliases still answer, and `listNcMirrorsInScope` still
 *     means the Nextcloud kind only.
 *
 * Run: cd server && node --test --test-force-exit stores/datatableStore.sourceMirrors.test.js
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
    pool: { query: rawQuery, connect: async () => client },
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
mock(path.join(SERVER, 'jobs/kbSourceRefresh'), { onDatatableChanged: () => {} });
mock(path.join(SERVER, 'core/webpages/webpageShareReconciler'), { onDatatableChanged: () => {} });

const store = require('./datatableStore');
const SC = store.orgScope('org_a');
const SC_B = store.orgScope('org_b');

const NC_SOURCE = { kind: 'nextcloud_table', ncTableId: 4, linkedByUserId: 'u_link', columnMap: {}, relations: [] };
const SS_SOURCE = {
    kind: 'spreadsheet_file', provider: 'onedrive', format: 'xlsx',
    file: { id: '01ABC', path: '/Documents/facturen.xlsx', name: 'facturen.xlsx' },
    sheet: { name: 'Facturen' }, linkedByUserId: 'u_link', columnMap: {}, relations: [],
};

async function insertMirror(id, scope, kind, source, { org = null, name = id } = {}) {
    await pg.query(
        `INSERT INTO datatables (id, scope_kind, scope_id, organization_id, owner_user_id, key, name, description, managed_kind, source)
         VALUES ($1, $2, $3, $4, 'u_link', $1, $5, 'test', $6, $7::jsonb)`,
        [id, scope.kind, scope.id, org, name, kind, JSON.stringify(source)],
    );
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await store.initDB();
    await insertMirror('tbl_nc', SC, 'nextcloud_table', NC_SOURCE, { org: 'org_a', name: 'Facturen (NC)' });
    await insertMirror('tbl_ss', SC, 'spreadsheet_file', SS_SOURCE, { org: 'org_a', name: 'Facturen (xlsx)' });
    await insertMirror('tbl_ss_b', SC_B, 'spreadsheet_file', { ...SS_SOURCE, linkedByUserId: 'u_other' }, { org: 'org_b' });
    await insertMirror('tbl_ss_gd', SC, 'spreadsheet_file', { ...SS_SOURCE, provider: 'google_drive', file: { id: 'g1', path: '/x.csv' } }, { org: 'org_a' });
    await pg.query(`INSERT INTO datatables (id, scope_kind, scope_id, organization_id, owner_user_id, key, name, description)
                    VALUES ('tbl_plain', 'org', 'org_a', 'org_a', 'u_link', 'plain', 'Plain', 'test')`);
});
after(async () => { await pg.close(); });

test('createSchema emits both new partial indexes', async () => {
    const idx = await rawQuery(`SELECT indexname FROM pg_indexes WHERE tablename = 'datatables'`);
    const names = idx.rows.map(r => r.indexname);
    for (const n of ['idx_datatables_nc_table', 'idx_datatables_nc_due', 'idx_datatables_source_file', 'idx_datatables_source_due']) {
        assert.ok(names.includes(n), n);
    }
});

test('the literal kind list is what the store knows', () => {
    assert.deepStrictEqual([...store.SOURCE_KINDS], ['nextcloud_table', 'spreadsheet_file']);
    assert.strictEqual(store.MIRROR_KIND, 'nextcloud_table');
});

test('claim → finish → due works for a spreadsheet mirror exactly as for a Nextcloud one', async () => {
    for (const id of ['tbl_nc', 'tbl_ss']) {
        const claimed = await store.claimSourceSync(id);
        assert.ok(claimed, `${id}: claimed`);
        assert.strictEqual(claimed.syncState.status, 'running');
        assert.ok(claimed.syncState.startedAt);
        assert.strictEqual(await store.claimSourceSync(id), null, `${id}: a second claim is refused`);
        assert.ok(await store.claimSourceSync(id, { staleMs: 0 }), `${id}: a stale claim can be taken over`);
        const done = await store.finishSourceSync(id, { status: 'ok', nextRunAt: '2000-01-01T00:00:00.000Z', staleReason: null });
        assert.strictEqual(done.syncState.status, 'ok');
        assert.strictEqual(done.syncState.startedAt, undefined, `${id}: the claim is released`);
    }
    const due = await store.listDueSourceSyncs(10);
    const ids = due.map(t => t.id);
    assert.ok(ids.includes('tbl_nc') && ids.includes('tbl_ss'), 'both kinds are due');
    assert.ok(ids.includes('tbl_ss_b') && ids.includes('tbl_ss_gd'), 'a never-run mirror (NULL state) is due');
    assert.ok(!ids.includes('tbl_plain'), 'an ordinary table is never a candidate');
});

test('an ordinary table can be neither claimed nor finished nor patched', async () => {
    assert.strictEqual(await store.claimSourceSync('tbl_plain'), null);
    assert.strictEqual(await store.finishSourceSync('tbl_plain', { status: 'ok' }), null);
    assert.strictEqual(await store.patchSyncState('tbl_plain', { marker: {} }), null);
    const row = await rawQuery(`SELECT sync_state FROM datatables WHERE id = 'tbl_plain'`);
    assert.strictEqual(row.rows[0].sync_state, null);
});

test('finishSourceSync keeps a staleReason set AFTER the claim, and clears one set before it', async () => {
    // Set before the claim: the pass that follows read the source after the
    // mark, so the finish may clear it.
    await store.markSourceStale('tbl_ss', 'event');
    await sleep(5);
    await store.claimSourceSync('tbl_ss', { staleMs: 0 });
    let done = await store.finishSourceSync('tbl_ss', { status: 'ok', staleReason: null });
    assert.strictEqual(done.syncState.staleReason, null, 'a mark from before the claim is cleared');

    // Set after the claim: a write-through landed while the pass was
    // fetching; the finishing pass must NOT clear it.
    await store.claimSourceSync('tbl_ss', { staleMs: 0 });
    await sleep(5);
    await store.markSourceStale('tbl_ss', 'write');
    done = await store.finishSourceSync('tbl_ss', { status: 'ok', staleReason: null, lastSuccessAt: new Date().toISOString() });
    assert.strictEqual(done.syncState.staleReason, 'write', 'a mark from after the claim survives the finish');
    assert.strictEqual(done.syncState.status, 'ok', 'the rest of the patch still lands');
    assert.strictEqual(done.syncState.startedAt, undefined);

    // And the next finish (a pass that started after the mark) clears it.
    await sleep(5);
    await store.claimSourceSync('tbl_ss', { staleMs: 0 });
    done = await store.finishSourceSync('tbl_ss', { status: 'ok', staleReason: null });
    assert.strictEqual(done.syncState.staleReason, null);
});

test('patchSyncState merges without touching a running claim', async () => {
    const claimed = await store.claimSourceSync('tbl_ss', { staleMs: 0 });
    const startedAt = claimed.syncState.startedAt;
    const patched = await store.patchSyncState('tbl_ss', { marker: { eTag: '"x"' }, contentHash: 'sha256:abc', lastWriteAt: '2026-09-13T10:00:00.000Z' });
    assert.strictEqual(patched.syncState.status, 'running');
    assert.strictEqual(patched.syncState.startedAt, startedAt);
    assert.deepStrictEqual(patched.syncState.marker, { eTag: '"x"' });
    assert.strictEqual(patched.syncState.contentHash, 'sha256:abc');
    await store.finishSourceSync('tbl_ss', { status: 'ok' });
    const after = await store.getDatatable('tbl_ss', SC);
    assert.strictEqual(after.syncState.contentHash, 'sha256:abc', 'a finish merges over it, never replaces it');
});

test('setSource and setSourceNextRun reach a spreadsheet mirror, never an ordinary table', async () => {
    const t = await store.setSource('tbl_ss', SC, { ...SS_SOURCE, refreshOnView: false });
    assert.strictEqual(t.source.refreshOnView, false);
    await store.setSource('tbl_plain', SC, { kind: 'nope' });
    const plain = await store.getDatatable('tbl_plain', SC);
    assert.strictEqual(plain.source, null, 'an ordinary table does not take a source block');
    await store.setSourceNextRun('tbl_ss', '2099-01-01T00:00:00.000Z');
    assert.strictEqual((await store.getDatatable('tbl_ss', SC)).syncState.nextRunAt, '2099-01-01T00:00:00.000Z');
    assert.ok(!(await store.listDueSourceSyncs(10)).some(x => x.id === 'tbl_ss'), 'moved out of the due list');
});

test('listSourceMirrorsByRef narrows to the organisation, the provider and the file', async () => {
    const hit = await store.listSourceMirrorsByRef('org_a', { kind: 'spreadsheet_file', provider: 'onedrive', fileId: '01ABC' });
    assert.deepStrictEqual(hit.map(t => t.id), ['tbl_ss']);
    assert.deepStrictEqual(await store.listSourceMirrorsByRef('org_a', { kind: 'spreadsheet_file', provider: 'google_drive', fileId: '01ABC' }), []);
    assert.deepStrictEqual(await store.listSourceMirrorsByRef('org_zzz', { kind: 'spreadsheet_file', provider: 'onedrive', fileId: '01ABC' }), []);
    assert.deepStrictEqual(await store.listSourceMirrorsByRef(null, { kind: 'spreadsheet_file', provider: 'onedrive', fileId: '01ABC' }), []);
    await assert.rejects(() => store.listSourceMirrorsByRef('org_a', { kind: 'bogus', provider: 'onedrive', fileId: '1' }), /unknown source kind/);
});

test('listSourceMirrorsByPath finds a mirror by the file path (a delete event carries no id)', async () => {
    const hit = await store.listSourceMirrorsByPath('org_a', { kind: 'spreadsheet_file', provider: 'onedrive', path: '/Documents/facturen.xlsx' });
    assert.deepStrictEqual(hit.map(t => t.id), ['tbl_ss']);
    assert.deepStrictEqual(await store.listSourceMirrorsByPath('org_a', { kind: 'spreadsheet_file', provider: 'onedrive', path: '/elsewhere.xlsx' }), []);
});

test('listSourceMirrorsByLinker lists one account\'s mirrors at one provider across scopes', async () => {
    const mine = await store.listSourceMirrorsByLinker('u_link', 'onedrive');
    assert.deepStrictEqual(mine.map(t => t.id).sort(), ['tbl_ss']);
    const theirs = await store.listSourceMirrorsByLinker('u_other', 'onedrive');
    assert.deepStrictEqual(theirs.map(t => t.id), ['tbl_ss_b']);
    assert.deepStrictEqual(await store.listSourceMirrorsByLinker('u_link', 'nextcloud_files'), []);
});

test('listSourceMirrorsInScope answers every kind, or one when asked; the alias keeps its Nextcloud meaning', async () => {
    const all = await store.listSourceMirrorsInScope(SC);
    assert.deepStrictEqual(all.map(t => t.id).sort(), ['tbl_nc', 'tbl_ss', 'tbl_ss_gd']);
    assert.deepStrictEqual((await store.listSourceMirrorsInScope(SC, { kind: 'spreadsheet_file' })).map(t => t.id).sort(), ['tbl_ss', 'tbl_ss_gd']);
    assert.deepStrictEqual((await store.listSourceMirrorsInScope(SC, { kind: 'nextcloud_table' })).map(t => t.id), ['tbl_nc']);
    assert.deepStrictEqual((await store.listNcMirrorsInScope(SC)).map(t => t.id), ['tbl_nc']);
    await assert.rejects(() => store.listSourceMirrorsInScope(SC, { kind: 'bogus' }), /unknown source kind/);
});

test('the one-release aliases are the same functions', () => {
    assert.strictEqual(store.claimNcSync, store.claimSourceSync);
    assert.strictEqual(store.finishNcSync, store.finishSourceSync);
    assert.strictEqual(store.setNcNextRun, store.setSourceNextRun);
    assert.strictEqual(store.markNcStale, store.markSourceStale);
    assert.strictEqual(store.listDueNcSyncs, store.listDueSourceSyncs);
});
