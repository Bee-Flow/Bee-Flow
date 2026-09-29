/**
 * Studio App Data Store — behaviour tests (App Studio v2 DATA ENGINE metadata).
 *
 * Postgres is replaced by a small in-memory stand-in implementing exactly the
 * SQL shapes this store issues (plain SELECT/INSERT/UPDATE/DELETE with `col=$n`
 * equalities, ORDER BY, RETURNING *). studioAppDbStore.applyMigration is a spy
 * so no real SQLite is touched; dataModel is the real (pure) contract.
 *
 * Covers: data-model CAS save (+ migration handoff), version conflict, invalid
 * model, dataset CRUD, dataset cache get/put/invalidate keyed by
 * viewer_scope_key + data_version, members, row counts + data versions.
 *
 * Run: node --test stores/studioAppDataStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── In-memory Postgres stand-in ───────────────────────────────────
let clock = Date.parse('2026-01-01T00:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();

const tables = {
    studio_apps: [
        { id: 'app1', user_id: 'owner1' },
        { id: 'app2', user_id: 'owner2' },
    ],
    studio_app_data_meta: [],
    studio_app_datasets: [],
    studio_app_dataset_cache: [],
    studio_app_members: [],
    studio_app_attachments: [],
};

function stripCast(tok) { return tok.replace(/::[a-z\[\]]+/gi, '').trim(); }

function whereConds(clause, params) {
    return [...clause.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/gi)].map(m => [m[1], params[Number(m[2]) - 1]]);
}

function matchRows(list, clause, params) {
    const conds = whereConds(clause, params);
    return list.filter(r => conds.every(([col, val]) => r[col] === val));
}

function doSelect(sql, params) {
    const m = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)\s*([\s\S]*)$/i);
    const [, colsRaw, tableName, rest] = m;
    const whereM = rest.match(/\bWHERE\b([\s\S]*?)(?:\bORDER BY\b|\bLIMIT\b|\bFOR UPDATE\b|$)/i);
    let rows = whereM ? matchRows(tables[tableName], whereM[1], params) : [...tables[tableName]];
    const orderM = rest.match(/\bORDER BY\b\s+([a-z_]+)\s*(ASC|DESC)?/i);
    if (orderM) {
        const col = orderM[1], desc = /desc/i.test(orderM[2] || '');
        rows = [...rows].sort((a, b) => {
            const av = a[col] ?? '', bv = b[col] ?? '';
            if (av < bv) return desc ? 1 : -1;
            if (av > bv) return desc ? -1 : 1;
            return 0;
        });
    }
    const cols = colsRaw.trim();
    let out;
    if (cols === '*') out = rows.map(r => ({ ...r }));
    else if (cols === '1') out = rows.map(() => ({ '?column?': 1 }));
    else {
        const names = cols.split(',').map(c => c.trim());
        out = rows.map(r => Object.fromEntries(names.map(n => [n, r[n]])));
    }
    return { rows: out, rowCount: out.length };
}

function doInsert(sql, params) {
    const m = sql.match(/^INSERT INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*(RETURNING \*)?/i);
    const tableName = m[1];
    const cols = m[2].split(',').map(c => c.trim());
    const vals = m[3].split(',').map(v => stripCast(v));
    const row = { created_at: tick(), updated_at: tick() };
    cols.forEach((c, i) => {
        const tok = vals[i];
        if (/^\$\d+$/.test(tok)) row[c] = params[Number(tok.slice(1)) - 1];
        else if (/NOW\(\)/i.test(tok)) row[c] = tick();
        else row[c] = tok.replace(/^'|'$/g, '');
    });
    tables[tableName].push(row);
    return { rows: m[4] ? [{ ...row }] : [], rowCount: 1 };
}

function doUpdate(sql, params) {
    const m = sql.match(/^UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*?)(RETURNING \*)?$/i);
    const tableName = m[1], setClause = m[2], whereClause = m[3].replace(/RETURNING \*/i, '');
    const matched = matchRows(tables[tableName], whereClause, params);
    const assigns = setClause.split(',').map(a => a.trim());
    for (const row of matched) {
        for (const a of assigns) {
            const am = a.match(/^([a-z_]+)\s*=\s*(.+)$/i);
            const col = am[1], rhs = stripCast(am[2]);
            if (/^\$\d+$/.test(rhs)) row[col] = params[Number(rhs.slice(1)) - 1];
            else if (/NOW\(\)/i.test(rhs)) row[col] = tick();
            else row[col] = rhs.replace(/^'|'$/g, '');
        }
    }
    return { rows: m[4] ? matched.map(r => ({ ...r })) : [], rowCount: matched.length };
}

function doDelete(sql, params) {
    const m = sql.match(/^DELETE FROM\s+(\w+)\s+WHERE\s+([\s\S]*)$/i);
    const tableName = m[1];
    const before = tables[tableName].length;
    tables[tableName] = tables[tableName].filter(r => !matchRows([r], m[2], params).length);
    return { rows: [], rowCount: before - tables[tableName].length };
}

// Minimal transactionality: BEGIN snapshots the tables, ROLLBACK restores
// them, COMMIT drops the snapshot. `failNextCommit` makes the next COMMIT
// throw AND restore (a real Postgres discards the tx on a failed commit) —
// this is how the SQLite-ahead-of-Postgres reconcile window is simulated.
let txSnapshot = null;
let failNextCommit = false;

function restoreTables(snap) {
    for (const k of Object.keys(tables)) {
        tables[k].length = 0;
        tables[k].push(...snap[k]);
    }
}

function dispatch(sql, params = []) {
    const s = String(sql).trim();
    if (/^BEGIN\b/i.test(s)) {
        txSnapshot = JSON.parse(JSON.stringify(tables));
        return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT\b/i.test(s)) {
        const snap = txSnapshot;
        txSnapshot = null;
        if (failNextCommit) {
            failNextCommit = false;
            if (snap) restoreTables(snap);
            throw new Error('injected commit failure');
        }
        return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK\b/i.test(s)) {
        const snap = txSnapshot;
        txSnapshot = null;
        if (snap) restoreTables(snap);
        return { rows: [], rowCount: 0 };
    }
    if (/^(CREATE|ALTER|DROP|DO)\b/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^SELECT/i.test(s)) return doSelect(s, params);
    if (/^INSERT/i.test(s)) return doInsert(s, params);
    if (/^UPDATE/i.test(s)) return doUpdate(s, params);
    if (/^DELETE/i.test(s)) return doDelete(s, params);
    throw new Error(`fake db: unsupported SQL: ${s}`);
}

const mockDb = {
    run: async (sql, params) => dispatch(sql, params),
    getOne: async (sql, params) => dispatch(sql, params).rows[0] || null,
    getAll: async (sql, params) => dispatch(sql, params).rows,
    exec: async () => undefined,
    getClient: async () => ({ query: async (sql, params) => dispatch(sql, params), release() {} }),
};

// applyMigration spy — records the plans (+ options) handed to the SQLite
// engine and mimics its PRAGMA user_version stamping so the reconcile flow is
// observable. `sqliteCounts` fakes the physical per-app tables: recountRows
// COUNT(*) queries answer from it; a key that's absent throws like a dropped
// table.
const migrationCalls = [];
const sqliteCounts = {};
let sqliteUserVersion = 0;
const mockDbStore = {
    applyMigration: async (ownerId, appId, plan, opts = {}) => {
        migrationCalls.push({ ownerId, appId, plan, opts });
        if (Number.isInteger(opts.targetVersion) && opts.targetVersion >= 0) {
            sqliteUserVersion = opts.targetVersion;
        }
        return { applied: plan.length, skipped: [] };
    },
    getSchemaStamp: async () => sqliteUserVersion,
    query: async (ownerId, appId, sql) => {
        const m = String(sql).match(/FROM "([^"]+)"/);
        const key = m && m[1];
        if (!key || !(key in sqliteCounts)) throw new Error(`no such table: ${key}`);
        return { rows: [{ n: sqliteCounts[key] }] };
    },
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db') return 'mock-db';
    if (request === './studioAppDbStore') return 'mock-dbstore';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };
require.cache['mock-dbstore'] = { id: 'mock-dbstore', exports: mockDbStore };

require('../appStudio/dataModel');
const store = require('./studioAppDataStore');

// A valid, canonical single-table model.
function validModel(fieldKey = 'title') {
    return {
        modelVersion: 1,
        tables: [{
            id: 'tbl_aaaaaa', key: 'people', name: 'People', icon: null,
            fields: [{ id: 'fld_aaaaaa', key: fieldKey, type: 'text', required: false, unique: false }],
            access: { default: 'app', roles: {}, rowFilters: {} },
        }],
        roles: [], roleMapping: { default: 'app', byGroup: {} },
    };
}

// ── Data model CAS + migration ────────────────────────────────────

test('saveDataModel: first save creates meta, hands the plan to the engine, bumps version', async () => {
    migrationCalls.length = 0;
    const res = await store.saveDataModel('app1', 'owner1', validModel());
    assert.deepStrictEqual(res, { ok: true, version: 1 });
    assert.strictEqual(migrationCalls.length, 1, 'migration applied once');
    assert.strictEqual(migrationCalls[0].appId, 'app1');
    assert.ok(migrationCalls[0].plan.some(s => /CREATE TABLE IF NOT EXISTS "people"/.test(s)), 'plan creates the table');
    assert.strictEqual(migrationCalls[0].opts.targetVersion, 1, 'the next model_version is stamped into user_version');

    const meta = await store.getDataModel('app1', 'owner1');
    assert.strictEqual(meta.modelVersion, 1);
    assert.strictEqual(meta.model.tables[0].key, 'people');
    // studio_apps mirror updated.
    assert.strictEqual(tables.studio_apps.find(a => a.id === 'app1').data_model_version, 1);
});

test('saveDataModel: CAS conflict returns the server copy, no migration', async () => {
    // app1 is now at version 1 from the previous test.
    migrationCalls.length = 0;
    const res = await store.saveDataModel('app1', 'owner1', validModel('renamed'), { expectedVersion: 0 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.conflict, true);
    assert.strictEqual(res.currentVersion, 1);
    assert.strictEqual(res.model.tables[0].fields[0].key, 'title', 'returns the persisted model');
    assert.strictEqual(migrationCalls.length, 0, 'no migration on conflict');
});

test('saveDataModel: matching expectedVersion succeeds and increments', async () => {
    const res = await store.saveDataModel('app1', 'owner1', validModel('title2'), { expectedVersion: 1 });
    assert.deepStrictEqual(res, { ok: true, version: 2 });
});

test('saveDataModel: invalid model is rejected before any write', async () => {
    migrationCalls.length = 0;
    const bad = { modelVersion: 1, tables: [{ id: 'nope', key: 'Bad Key', fields: [] }] };
    const res = await store.saveDataModel('app1', 'owner1', bad);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.invalid, true);
    assert.ok(res.errors.length > 0);
    assert.strictEqual(migrationCalls.length, 0);
});

test('saveDataModel: foreign / unowned app is notFound', async () => {
    // owner2 owns app2, so owner1 saving into app2 must fail.
    const res = await store.saveDataModel('app2', 'owner1', validModel());
    assert.deepStrictEqual(res, { ok: false, notFound: true });
});

test('getDataModel: foreign owner sees nothing', async () => {
    assert.strictEqual(await store.getDataModel('app1', 'owner2'), null);
});

// ── Data versions + row counts ────────────────────────────────────

test('bumpDataVersion increments per table; setRowCount/getRowCounts round-trip', async () => {
    assert.strictEqual(await store.bumpDataVersion('app1', 'people', 'owner1'), 1);
    assert.strictEqual(await store.bumpDataVersion('app1', 'people', 'owner1'), 2);
    assert.strictEqual(await store.bumpDataVersion('app1', 'other', 'owner1'), 1);
    // Foreign owner → null, no bump.
    assert.strictEqual(await store.bumpDataVersion('app1', 'people', 'owner2'), null);

    assert.deepStrictEqual(await store.setRowCount('app1', 'people', 42, 'owner1'), { people: 42 });
    assert.deepStrictEqual(await store.getRowCounts('app1', 'owner1'), { people: 42 });
    assert.deepStrictEqual(await store.getRowCounts('app1', 'owner2'), {}, 'foreign owner sees no counts');
});

test('bumpRowCount applies deltas under the setRowCount lock and clamps at 0', async () => {
    await store.setRowCount('app1', 'people', 2, 'owner1');
    assert.deepStrictEqual(await store.bumpRowCount('app1', 'people', 1, 'owner1'), { people: 3 });
    assert.deepStrictEqual(await store.bumpRowCount('app1', 'people', -2, 'owner1'), { people: 1 });
    assert.deepStrictEqual(await store.bumpRowCount('app1', 'people', -5, 'owner1'), { people: 0 }, 'never goes negative');
    // Foreign owner → null, no bump.
    assert.strictEqual(await store.bumpRowCount('app1', 'people', 1, 'owner2'), null);
    assert.deepStrictEqual(await store.getRowCounts('app1', 'owner1'), { people: 0 });
});

test('recountRows: authoritative COUNT(*) per model table; a dropped table falls out of the map', async () => {
    // Stale cache: 'people' undercounted + a leftover entry for a dropped table.
    await store.setRowCount('app1', 'people', 1, 'owner1');
    await store.setRowCount('app1', 'dropped', 9, 'owner1');
    sqliteCounts.people = 7;
    const counts = await store.recountRows('app1', 'owner1', [{ key: 'people', fields: [] }]);
    assert.deepStrictEqual(counts, { people: 7 }, 'recounted + the dropped table is gone');
    assert.deepStrictEqual(await store.getRowCounts('app1', 'owner1'), { people: 7 });
    // Foreign owner → null, counts untouched.
    assert.strictEqual(await store.recountRows('app1', 'owner2', [{ key: 'people', fields: [] }]), null);
    // A model table whose physical relation is missing counts as 0.
    const withGhost = await store.recountRows('app1', 'owner1', [{ key: 'people', fields: [] }, { key: 'ghost', fields: [] }]);
    assert.deepStrictEqual(withGhost, { people: 7, ghost: 0 });
});

test('saveDataModel recounts row_counts on success (best-effort, after commit)', async () => {
    sqliteCounts.people = 3;
    const res = await store.saveDataModel('app1', 'owner1', validModel('title3'));
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(await store.getRowCounts('app1', 'owner1'), { people: 3 });
});

// ── Reconcile (the SQLite-ahead-of-Postgres window) ───────────────

test('reconcileDataModel: a cleanly saved model reports no drift; unowned app is notFound', async () => {
    const meta = await store.getDataModel('app1', 'owner1');
    const rec = await store.reconcileDataModel('app1', 'owner1');
    assert.deepStrictEqual(rec, {
        ok: true, drift: false,
        sqliteVersion: meta.modelVersion, modelVersion: meta.modelVersion,
    });
    assert.deepStrictEqual(await store.reconcileDataModel('app2', 'owner1'), { ok: false, notFound: true });
});

test('PG COMMIT failure after applyMigration: drift reported + recounted, retried save clears it', async () => {
    const before = await store.getDataModel('app1', 'owner1');
    sqliteCounts.people = 5; // "physical" truth the reconcile recount must adopt
    await store.setRowCount('app1', 'people', 999, 'owner1'); // stale cached count

    // The SQLite migration (with its user_version stamp) succeeds; the PG
    // commit then fails — nothing persists on the Postgres side.
    failNextCommit = true;
    await assert.rejects(
        () => store.saveDataModel('app1', 'owner1', validModel('title4')),
        /injected commit failure/,
    );
    const after = await store.getDataModel('app1', 'owner1');
    assert.strictEqual(after.modelVersion, before.modelVersion, 'model_version rolled back with the failed commit');
    assert.deepStrictEqual(after.model, before.model, 'the old model is still the persisted one');

    // Reconcile sees user_version one ahead and recounts rows.
    const rec = await store.reconcileDataModel('app1', 'owner1');
    assert.deepStrictEqual(rec, {
        ok: true, drift: true,
        sqliteVersion: before.modelVersion + 1, modelVersion: before.modelVersion,
    });
    assert.deepStrictEqual(await store.getRowCounts('app1', 'owner1'), { people: 5 }, 'drift triggered an authoritative recount');

    // Retrying the SAME save succeeds (the engine replays the plan tolerantly)
    // and re-stamps user_version — the drift is gone.
    const retry = await store.saveDataModel('app1', 'owner1', validModel('title4'));
    assert.deepStrictEqual(retry, { ok: true, version: before.modelVersion + 1 });
    assert.strictEqual(
        migrationCalls[migrationCalls.length - 1].opts.targetVersion,
        before.modelVersion + 1,
        'the retry re-stamps the same user_version',
    );
    const rec2 = await store.reconcileDataModel('app1', 'owner1');
    assert.deepStrictEqual(rec2, {
        ok: true, drift: false,
        sqliteVersion: retry.version, modelVersion: retry.version,
    });
});

test('getDataModel({ reconcile:true }) runs the reconcile lazily and never lets it break the read', async () => {
    // Drifted state again: stamp ahead without persisting.
    const before = await store.getDataModel('app1', 'owner1');
    sqliteCounts.people = 8;
    await store.setRowCount('app1', 'people', 0, 'owner1');
    failNextCommit = true;
    await assert.rejects(() => store.saveDataModel('app1', 'owner1', validModel('title5')));

    const meta = await store.getDataModel('app1', 'owner1', { reconcile: true });
    assert.strictEqual(meta.modelVersion, before.modelVersion, 'the read still answers the persisted model');
    assert.deepStrictEqual(await store.getRowCounts('app1', 'owner1'), { people: 8 }, 'the lazy reconcile recounted');

    // A blown-up user_version read must not break the read either.
    const origGetUserVersion = mockDbStore.getSchemaStamp;
    mockDbStore.getSchemaStamp = async () => { throw new Error('sqlite unavailable'); };
    try {
        const still = await store.getDataModel('app1', 'owner1', { reconcile: true });
        assert.strictEqual(still.modelVersion, before.modelVersion);
    } finally {
        mockDbStore.getSchemaStamp = origGetUserVersion;
    }

    // Heal the drift so later tests see a clean state.
    const heal = await store.saveDataModel('app1', 'owner1', validModel('title5'));
    assert.strictEqual(heal.ok, true);
});

// ── Datasets ──────────────────────────────────────────────────────

test('dataset CRUD is owner + app scoped', async () => {
    const ds = await store.createDataset('app1', 'owner1', { name: 'Active people', tableId: 'tbl_aaaaaa', descriptor: { filter: [] }, cacheTtlSeconds: 30 });
    assert.strictEqual(ds.name, 'Active people');
    assert.strictEqual(ds.cacheTtlSeconds, 30);

    const list = await store.listDatasets('app1', 'owner1');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(await store.getDataset(ds.id, 'app1', 'owner1') && (await store.getDataset(ds.id, 'app1', 'owner1')).id, ds.id);
    // Foreign owner cannot read it.
    assert.strictEqual(await store.getDataset(ds.id, 'app1', 'owner2'), null);
    assert.deepStrictEqual(await store.listDatasets('app1', 'owner2'), []);

    const upd = await store.updateDataset(ds.id, 'app1', 'owner1', { name: 'Renamed' });
    assert.strictEqual(upd.name, 'Renamed');
    assert.strictEqual(await store.updateDataset(ds.id, 'app1', 'owner2', { name: 'hax' }), null, 'foreign update refused');

    assert.strictEqual(await store.deleteDataset(ds.id, 'app1', 'owner2'), false, 'foreign delete refused');
    assert.strictEqual(await store.deleteDataset(ds.id, 'app1', 'owner1'), true);
    assert.deepStrictEqual(await store.listDatasets('app1', 'owner1'), []);
});

// ── Dataset cache ─────────────────────────────────────────────────

test('cache get/put keyed by viewer_scope_key + params_hash + data_version', async () => {
    const ds = await store.createDataset('app1', 'owner1', { name: 'C' });
    const scope = 'role:member';
    await store.putCache(ds.id, { viewerScopeKey: scope, paramsHash: 'h1', dataVersion: 5, result: { rows: [1, 2] }, rowCount: 2, ttlSeconds: 60 });

    const hit = await store.getCache(ds.id, scope, 'h1', 5);
    assert.ok(hit);
    assert.deepStrictEqual(hit.result, { rows: [1, 2] });
    assert.strictEqual(hit.rowCount, 2);

    assert.strictEqual(await store.getCache(ds.id, scope, 'h1', 6), null, 'stale data_version → miss');
    assert.strictEqual(await store.getCache(ds.id, 'role:admin', 'h1', 5), null, 'different viewer scope → miss');
    assert.strictEqual(await store.getCache(ds.id, scope, 'h2', 5), null, 'different params → miss');

    await store.invalidateCache(ds.id);
    assert.strictEqual(await store.getCache(ds.id, scope, 'h1', 5), null, 'invalidated → miss');
});

test('cache respects expiry', async () => {
    const ds = await store.createDataset('app1', 'owner1', { name: 'E' });
    await store.putCache(ds.id, { viewerScopeKey: 's', paramsHash: 'h', dataVersion: 1, result: {}, rowCount: 0, ttlSeconds: -10 });
    assert.strictEqual(await store.getCache(ds.id, 's', 'h', 1), null, 'expired entry → miss');
});

// ── Members ───────────────────────────────────────────────────────

test('members: add/list/role/remove are owner-gated', async () => {
    const m = await store.addMember('app1', 'owner1', 'userX', 'editor');
    assert.strictEqual(m.roleKey, 'editor');
    // Re-role via upsert.
    const m2 = await store.addMember('app1', 'owner1', 'userX', 'viewer');
    assert.strictEqual(m2.roleKey, 'viewer');
    assert.strictEqual((await store.listMembers('app1', 'owner1')).length, 1, 'no duplicate row on re-role');

    assert.strictEqual(await store.getMemberRole('app1', 'userX'), 'viewer');
    assert.strictEqual(await store.getMemberRole('app1', 'ghost'), null);

    // Foreign owner cannot add/list/remove.
    assert.strictEqual(await store.addMember('app1', 'owner2', 'evil', 'admin'), null);
    assert.deepStrictEqual(await store.listMembers('app1', 'owner2'), []);
    assert.strictEqual(await store.removeMember('app1', 'owner2', 'userX'), false);

    assert.strictEqual(await store.removeMember('app1', 'owner1', 'userX'), true);
    assert.deepStrictEqual(await store.listMembers('app1', 'owner1'), []);
});

// ── Attachments ───────────────────────────────────────────────────

test('attachments: add/list/get/scan/delete/count owner-scoped', async () => {
    const a = await store.addAttachment('app1', 'owner1', { recordId: 'rec_1', fieldKey: 'file', mimeType: 'image/png', sha256: 'abc', size: 123 });
    assert.strictEqual(a.mimeType, 'image/png');
    assert.strictEqual(a.scanned, false);

    assert.strictEqual((await store.listAttachments('app1', 'owner1')).length, 1);
    assert.strictEqual((await store.listAttachments('app1', 'owner1', { recordId: 'rec_1' })).length, 1);
    assert.deepStrictEqual(await store.listAttachments('app1', 'owner2'), [], 'foreign owner sees none');
    assert.strictEqual(await store.countAttachments('app1', 'owner1'), 1);

    const scanned = await store.setAttachmentScan(a.id, 'app1', 'owner1', { scanned: true, quarantined: true });
    assert.strictEqual(scanned.scanned, true);
    assert.strictEqual(scanned.quarantined, true);
    assert.strictEqual(await store.setAttachmentScan(a.id, 'app1', 'owner2', { scanned: true }), null, 'foreign scan refused');

    assert.strictEqual(await store.getAttachment(a.id, 'app1', 'owner2'), null);
    assert.strictEqual(await store.deleteAttachment(a.id, 'app1', 'owner2'), false);
    assert.strictEqual(await store.deleteAttachment(a.id, 'app1', 'owner1'), true);
    assert.strictEqual(await store.countAttachments('app1', 'owner1'), 0);
});
