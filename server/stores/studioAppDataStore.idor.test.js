/**
 * Studio App Data Store cross-tenant IDOR regression tests.
 *
 * Locks the invariant that EVERY mutation of App Studio v2 data metadata is
 * owner-scoped, so a foreign app/dataset/attachment id can never be written
 * through by guessing it:
 *   • studio_app_data_meta / _datasets / _attachments carry owner_user_id in
 *     their WHERE (or, for INSERTs, in their params);
 *   • studio_app_members has no owner column, so its mutations are gated by an
 *     ownsApp() check that scopes studio_apps by user_id.
 *
 * We mock ../db (recording every SQL + params, WHERE matching mimics Postgres)
 * and ./studioAppDbStore (applyMigration is a no-op spy), then assert on the
 * recorded statements. dataModel is the real pure contract.
 *
 * Run: node --test stores/studioAppDataStore.idor.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// A valid model reused as both the persisted + incoming model (identical → the
// migration plan is empty, so saveDataModel's success path still writes meta).
const VALID_MODEL = JSON.stringify({
    modelVersion: 1,
    tables: [{
        id: 'tbl_aaaaaa', key: 'people', name: 'People', icon: null,
        fields: [{ id: 'fld_aaaaaa', key: 'title', type: 'text', required: false, unique: false }],
        access: { default: 'app', roles: {}, rowFilters: {} },
    }],
    roles: [], roleMapping: { default: 'app', byGroup: {} },
});

// ── Seed rows ──────────────────────────────────────────────────────
const appRows = [
    { id: 'app-alice', user_id: 'alice' },
    { id: 'app-bob', user_id: 'bob' },
];
const metaRows = [
    { app_id: 'app-alice', owner_user_id: 'alice', model: VALID_MODEL, model_version: 1, data_versions: '{}', row_counts: '{}' },
];
const datasetRows = [
    { id: 'ds-alice', app_id: 'app-alice', owner_user_id: 'alice', name: 'A', table_id: null, source: '{}', descriptor: '{}', cache_ttl_seconds: 60 },
    { id: 'ds-bob', app_id: 'app-bob', owner_user_id: 'bob', name: 'B', table_id: null, source: '{}', descriptor: '{}', cache_ttl_seconds: 60 },
];
const memberRows = [
    { app_id: 'app-alice', user_id: 'm1', role_key: 'editor' },
];
const attachmentRows = [
    { id: 'att-alice', app_id: 'app-alice', owner_user_id: 'alice', record_id: 'r1', field_key: 'f', mime_type: 'image/png', sha256: 'x', size: 1, scanned: false, quarantined: false },
    { id: 'att-bob', app_id: 'app-bob', owner_user_id: 'bob', record_id: 'r2', field_key: 'f', mime_type: 'image/png', sha256: 'y', size: 1, scanned: false, quarantined: false },
];

const calls = { getOne: [], getAll: [], run: [], client: [] };

function whereConds(sql, params) {
    const m = sql.match(/\bWHERE\b([\s\S]*)/i);
    if (!m) return [];
    return [...m[1].matchAll(/([a-z_]+)\s*=\s*\$(\d+)/gi)].map(x => [x[1], params[Number(x[2]) - 1]]);
}

function rowsFor(sql) {
    if (/studio_app_dataset_cache/i.test(sql)) return [];
    if (/studio_app_datasets/i.test(sql)) return datasetRows;
    if (/studio_app_data_meta/i.test(sql)) return metaRows;
    if (/studio_app_members/i.test(sql)) return memberRows;
    if (/studio_app_attachments/i.test(sql)) return attachmentRows;
    if (/\bstudio_apps\b/i.test(sql)) return appRows;
    return [];
}

function matchRows(sql, params) {
    const conds = whereConds(sql, params);
    return rowsFor(sql).filter(r => conds.every(([col, val]) => r[col] === val));
}

function dispatch(sql, params = []) {
    const s = String(sql).trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP|DO)\b/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^SELECT/i.test(s)) {
        const rows = matchRows(s, params).map(r => ({ ...r }));
        return { rows, rowCount: rows.length };
    }
    const matched = matchRows(s, params);
    return { rows: matched.map(r => ({ ...r })), rowCount: matched.length };
}

const mockDb = {
    run: async (sql, params = []) => { calls.run.push({ sql, params }); return dispatch(sql, params); },
    getOne: async (sql, params = []) => { calls.getOne.push({ sql, params }); return dispatch(sql, params).rows[0] || null; },
    getAll: async (sql, params = []) => { calls.getAll.push({ sql, params }); return dispatch(sql, params).rows; },
    exec: async () => undefined,
    getClient: async () => ({
        query: async (sql, params = []) => { calls.client.push({ sql, params }); return dispatch(sql, params); },
        release() {},
    }),
};
const mockDbStore = { applyMigration: async () => ({ applied: 0 }) };

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db') return 'mock-db';
    if (request === './studioAppDbStore') return 'mock-dbstore';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };
require.cache['mock-dbstore'] = { id: 'mock-dbstore', exports: mockDbStore };

const store = require('./studioAppDataStore');

function reset() { calls.getOne = []; calls.getAll = []; calls.run = []; calls.client = []; }
function allMutations() {
    // INSERT … RETURNING * runs through getOne, so include all three sinks.
    return [...calls.run, ...calls.client, ...calls.getOne].filter(c => /^(UPDATE|DELETE|INSERT)/i.test(c.sql.trim()));
}
const incoming = () => JSON.parse(VALID_MODEL);

// ── saveDataModel ─────────────────────────────────────────────────

test('saveDataModel: foreign app with no meta is refused via owner-scoped studio_apps check', async () => {
    reset();
    const res = await store.saveDataModel('app-bob', 'alice', incoming());
    assert.deepStrictEqual(res, { ok: false, notFound: true });
    const own = calls.client.find(c => /FROM studio_apps/i.test(c.sql));
    assert.match(own.sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i, 'ownership check scopes studio_apps by user_id');
    assert.deepStrictEqual(own.params, ['app-bob', 'alice']);
    assert.strictEqual(allMutations().length, 0, 'no writes for a foreign app');
});

test('saveDataModel: a meta row owned by another user is refused (no clobber)', async () => {
    reset();
    const res = await store.saveDataModel('app-alice', 'bob', incoming());
    assert.deepStrictEqual(res, { ok: false, notFound: true });
    assert.strictEqual(allMutations().length, 0, 'a foreign owner writes nothing over an existing meta row');
});

test('saveDataModel: owner path scopes both the meta UPDATE and the studio_apps mirror', async () => {
    reset();
    const res = await store.saveDataModel('app-alice', 'alice', incoming());
    assert.strictEqual(res.ok, true);
    const metaUpd = calls.client.find(c => /^UPDATE studio_app_data_meta/i.test(c.sql.trim()));
    assert.match(metaUpd.sql, /WHERE\s+app_id\s*=\s*\$\d+\s+AND\s+owner_user_id\s*=\s*\$\d+/i, 'meta UPDATE scoped by owner_user_id');
    assert.ok(metaUpd.params.includes('alice'));
    const appUpd = calls.client.find(c => /^UPDATE studio_apps/i.test(c.sql.trim()));
    assert.match(appUpd.sql, /WHERE\s+id\s*=\s*\$\d+\s+AND\s+user_id\s*=\s*\$\d+/i, 'studio_apps mirror scoped by user_id');
});

// ── bumpDataVersion / setRowCount ─────────────────────────────────

test('bumpDataVersion + setRowCount lock rows scoped by owner_user_id; foreign → null, no write', async () => {
    reset();
    assert.strictEqual(await store.bumpDataVersion('app-alice', 'people', 'bob'), null);
    assert.strictEqual(await store.setRowCount('app-alice', 'people', 5, 'bob'), null);
    for (const c of calls.client.filter(c => /FOR UPDATE/i.test(c.sql))) {
        assert.match(c.sql, /WHERE\s+app_id\s*=\s*\$1\s+AND\s+owner_user_id\s*=\s*\$2/i, 'locking SELECT scoped by owner_user_id');
    }
    assert.strictEqual(allMutations().length, 0, 'no writes when the owner-scoped lock finds nothing');
});

// ── Datasets ──────────────────────────────────────────────────────

test('createDataset INSERT records owner_user_id', async () => {
    reset();
    await store.createDataset('app-alice', 'alice', { name: 'X' });
    const ins = calls.getOne.find(c => /^INSERT INTO studio_app_datasets/i.test(c.sql.trim()));
    assert.match(ins.sql, /owner_user_id/i, 'INSERT lists owner_user_id');
    assert.ok(ins.params.includes('alice'), 'and binds the caller as owner');
});

test('dataset reads/writes are scoped by app_id AND owner_user_id; foreign refused', async () => {
    reset();
    assert.strictEqual(await store.getDataset('ds-bob', 'app-bob', 'alice'), null);
    const sel = calls.getOne.find(c => /^SELECT \* FROM studio_app_datasets/i.test(c.sql.trim()));
    assert.match(sel.sql, /app_id\s*=\s*\$2\s+AND\s+owner_user_id\s*=\s*\$3/i);

    reset();
    assert.strictEqual(await store.updateDataset('ds-bob', 'app-bob', 'alice', { name: 'hax' }), null);
    const upd = calls.getOne.find(c => /^UPDATE studio_app_datasets/i.test(c.sql.trim()));
    assert.match(upd.sql, /WHERE[\s\S]*app_id\s*=\s*\$\d+\s+AND\s+owner_user_id\s*=\s*\$\d+/i);

    reset();
    assert.strictEqual(await store.deleteDataset('ds-bob', 'app-bob', 'alice'), false);
    assert.ok(!calls.run.some(c => /^DELETE FROM studio_app_datasets/i.test(c.sql.trim())), 'no dataset DELETE for a foreign owner');
    const lookup = calls.getOne.find(c => /SELECT id FROM studio_app_datasets/i.test(c.sql));
    assert.match(lookup.sql, /owner_user_id\s*=\s*\$3/i);
});

// ── Members (ownsApp-gated) ───────────────────────────────────────

test('member mutations are gated by an owner-scoped ownsApp check', async () => {
    reset();
    assert.strictEqual(await store.addMember('app-alice', 'bob', 'evil', 'admin'), null);
    assert.ok(!allMutations().some(c => /studio_app_members/i.test(c.sql)), 'no member INSERT/UPDATE for a foreign caller');

    reset();
    assert.strictEqual(await store.removeMember('app-alice', 'bob', 'm1'), false);
    assert.ok(!calls.run.some(c => /^DELETE FROM studio_app_members/i.test(c.sql.trim())), 'no member DELETE for a foreign caller');
    const gate = calls.getOne.find(c => /FROM studio_apps/i.test(c.sql));
    assert.match(gate.sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i, 'ownsApp scopes studio_apps by user_id');
    assert.deepStrictEqual(gate.params, ['app-alice', 'bob']);

    // Owner path actually mutates.
    reset();
    await store.addMember('app-alice', 'alice', 'newuser', 'viewer');
    assert.ok(allMutations().some(c => /studio_app_members/i.test(c.sql)), 'owner add mutates members');
});

// ── Attachments ───────────────────────────────────────────────────

test('attachment reads/writes are scoped by app_id AND owner_user_id; foreign refused', async () => {
    reset();
    assert.strictEqual(await store.getAttachment('att-bob', 'app-bob', 'alice'), null);
    const sel = calls.getOne.find(c => /^SELECT \* FROM studio_app_attachments/i.test(c.sql.trim()));
    assert.match(sel.sql, /app_id\s*=\s*\$2\s+AND\s+owner_user_id\s*=\s*\$3/i);

    reset();
    assert.strictEqual(await store.setAttachmentScan('att-bob', 'app-bob', 'alice', { scanned: true }), null);
    const upd = calls.getOne.find(c => /^UPDATE studio_app_attachments/i.test(c.sql.trim()));
    assert.match(upd.sql, /WHERE[\s\S]*app_id\s*=\s*\$\d+\s+AND\s+owner_user_id\s*=\s*\$\d+/i);

    reset();
    assert.strictEqual(await store.deleteAttachment('att-bob', 'app-bob', 'alice'), false);
    assert.ok(!calls.run.some(c => /^DELETE FROM studio_app_attachments/i.test(c.sql.trim())), 'no attachment DELETE for a foreign owner');

    reset();
    await store.addAttachment('app-alice', 'alice', { recordId: 'r', fieldKey: 'f', mimeType: 'image/png', sha256: 'z', size: 2 });
    const ins = calls.getOne.find(c => /^INSERT INTO studio_app_attachments/i.test(c.sql.trim()));
    assert.match(ins.sql, /owner_user_id/i);
    assert.ok(ins.params.includes('alice'));
});

// ── Blanket invariant ─────────────────────────────────────────────

test('every owner-columned mutation carries owner_user_id in its WHERE/params', async () => {
    reset();
    // Exercise a spread of owner paths.
    await store.saveDataModel('app-alice', 'alice', incoming());
    await store.bumpDataVersion('app-alice', 'people', 'alice');
    await store.updateDataset('ds-alice', 'app-alice', 'alice', { name: 'Y' });
    await store.setAttachmentScan('att-alice', 'app-alice', 'alice', { scanned: true });

    for (const c of allMutations()) {
        const sql = c.sql.trim();
        // Members are ownsApp-gated (no owner col) — asserted separately.
        if (/studio_app_members/i.test(sql)) continue;
        // studio_apps mirror uses user_id (its own owner column).
        if (/^UPDATE studio_apps\b/i.test(sql)) { assert.match(sql, /user_id\s*=\s*\$\d+/i); continue; }
        if (/studio_app_(data_meta|datasets|attachments)/i.test(sql)) {
            if (/^INSERT/i.test(sql)) assert.match(sql, /owner_user_id/i, `INSERT names owner_user_id: ${sql}`);
            else assert.match(sql, /owner_user_id\s*=\s*\$\d+/i, `mutation scopes owner_user_id: ${sql}`);
        }
    }
});
