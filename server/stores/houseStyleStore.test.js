/**
 * houseStyleStore — the org's default house style must never be cleared unless
 * a replacement is written in the same transaction. The fake `db` (in-memory
 * table with rollback semantics) is handed to createHouseStyleStore, so no
 * Postgres is involved and nothing is parked in require.cache where a later
 * suite in the same process would pick it up.
 *
 * Regression: `update(id, orgId, { isDefault: true })` used to run an
 * unconditional `clearDefault(orgId)` before an UPDATE whose
 * `WHERE id = $n AND org_id = $n+1` may match nothing (stale id, id copied from
 * another organisation, concurrent delete). The clear was committed anyway, so
 * the org was left with NO default while the route answered 404. `create()` had
 * the same shape: clear first, then an INSERT that may fail.
 *
 * Run: node --test server/stores/houseStyleStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { createHouseStyleStore } = require('./houseStyleStore');

// ── in-memory org_house_styles ───────────────────────────
let rows = [];
const state = { failInsert: false };

function runSql(sql, params = []) {
    if (/UPDATE org_house_styles SET is_default = FALSE WHERE org_id = \$1 AND is_default = TRUE/.test(sql)) {
        let n = 0;
        for (const r of rows) if (r.org_id === params[0] && r.is_default) { r.is_default = false; n++; }
        return { rowCount: n, rows: [] };
    }
    const upd = /^UPDATE org_house_styles SET (.+) WHERE id = \$(\d+) AND org_id = \$(\d+)$/.exec(sql);
    if (upd) {
        const target = rows.find(r => r.id === params[Number(upd[2]) - 1] && r.org_id === params[Number(upd[3]) - 1]);
        if (!target) return { rowCount: 0, rows: [] };
        if (/is_default = TRUE/.test(upd[1])) target.is_default = true;
        if (/is_default = FALSE/.test(upd[1])) target.is_default = false;
        const name = /name = \$(\d+)/.exec(upd[1]);
        if (name) target.name = params[Number(name[1]) - 1];
        // The partial unique index allows at most one default per org.
        assert.ok(rows.filter(r => r.org_id === target.org_id && r.is_default).length <= 1,
            'uniq_house_styles_default violated');
        return { rowCount: 1, rows: [] };
    }
    if (/^INSERT INTO org_house_styles/.test(sql)) {
        if (state.failInsert) throw new Error('docx_blob write failed');
        rows.push({
            id: params[0], org_id: params[1], name: params[2], description: params[3],
            style_meta: {}, is_default: params[6], created_by: params[7],
            created_at: 'T', updated_at: 'T',
        });
        return { rowCount: 1, rows: [] };
    }
    if (/SELECT id FROM org_house_styles WHERE id = \$1 AND org_id = \$2 FOR UPDATE/.test(sql)) {
        const r = rows.find(x => x.id === params[0] && x.org_id === params[1]);
        return { rowCount: r ? 1 : 0, rows: r ? [{ id: r.id }] : [] };
    }
    if (/^DELETE FROM org_house_styles/.test(sql)) {
        const before = rows.length;
        rows = rows.filter(r => !(r.id === params[0] && r.org_id === params[1]));
        return { rowCount: before - rows.length, rows: [] };
    }
    throw new Error('unexpected SQL: ' + sql);
}

const mockDb = {
    exec: async () => {},
    run: async (sql, params) => runSql(sql, params),
    getAll: async (sql, params) => rows.filter(r => r.org_id === params[0]),
    getOne: async (sql, params) => {
        if (/WHERE org_id = \$1 AND is_default = TRUE/.test(sql)) {
            return rows.find(r => r.org_id === params[0] && r.is_default) || null;
        }
        if (/WHERE id = \$1 AND org_id = \$2/.test(sql)) {
            return rows.find(r => r.id === params[0] && r.org_id === params[1]) || null;
        }
        return null;
    },
    getClient: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    // Snapshot/restore stands in for BEGIN … ROLLBACK.
    withTransaction: async (fn) => {
        const snapshot = rows.map(r => ({ ...r }));
        try {
            return await fn({ query: async (sql, params) => runSql(sql, params) });
        } catch (err) {
            rows = snapshot;
            throw err;
        }
    },
};
const store = createHouseStyleStore(mockDb);

beforeEach(() => {
    state.failInsert = false;
    rows = [
        { id: 'a', org_id: 'org1', name: 'Corporate', description: '', style_meta: {}, is_default: true, created_by: 'u1', created_at: 'T', updated_at: 'T' },
        { id: 'b', org_id: 'org1', name: 'Letterhead', description: '', style_meta: {}, is_default: false, created_by: 'u1', created_at: 'T', updated_at: 'T' },
        { id: 'c', org_id: 'org2', name: 'Other org', description: '', style_meta: {}, is_default: true, created_by: 'u2', created_at: 'T', updated_at: 'T' },
    ];
});

test('update({isDefault:true}) on an unknown id leaves the org default intact', async () => {
    const res = await store.update('does-not-exist', 'org1', { isDefault: true });
    assert.strictEqual(res, null, 'no row updated → null (route turns this into 404)');
    const def = await store.getDefaultForOrg('org1');
    assert.ok(def, 'org1 still has a default house style');
    assert.strictEqual(def.id, 'a');
});

test('update({isDefault:true}) with an id from another org does not clear this org default', async () => {
    const res = await store.update('c', 'org1', { isDefault: true });
    assert.strictEqual(res, null);
    assert.strictEqual((await store.getDefaultForOrg('org1'))?.id, 'a', 'org1 default untouched');
    assert.strictEqual((await store.getDefaultForOrg('org2'))?.id, 'c', 'org2 default untouched');
});

test('update({isDefault:true}) still moves the default for a real row', async () => {
    const res = await store.update('b', 'org1', { isDefault: true });
    assert.strictEqual(res?.id, 'b');
    assert.strictEqual(res.isDefault, true);
    assert.strictEqual((await store.getDefaultForOrg('org1')).id, 'b');
    assert.strictEqual(rows.find(r => r.id === 'a').is_default, false, 'previous default cleared');
});

test('update without isDefault never touches the default flag', async () => {
    const res = await store.update('b', 'org1', { name: 'Renamed' });
    assert.strictEqual(res.name, 'Renamed');
    assert.strictEqual((await store.getDefaultForOrg('org1')).id, 'a');
});

test('update({isDefault:false}) clears only the targeted row', async () => {
    const res = await store.update('a', 'org1', { isDefault: false });
    assert.strictEqual(res.isDefault, false);
    assert.strictEqual(await store.getDefaultForOrg('org1'), null);
});

test('create(makeDefault) rolls the clear back when the INSERT fails', async () => {
    state.failInsert = true;
    await assert.rejects(
        () => store.create({ orgId: 'org1', name: 'New', docxBuffer: Buffer.from('x'), styleMeta: {}, makeDefault: true }),
        /docx_blob write failed/
    );
    const def = await store.getDefaultForOrg('org1');
    assert.strictEqual(def?.id, 'a', 'old default survives a failed create');
});

test('create(makeDefault) hands the default to the new row on success', async () => {
    const created = await store.create({ orgId: 'org1', name: 'New', docxBuffer: Buffer.from('x'), styleMeta: {}, makeDefault: true });
    assert.strictEqual(created.isDefault, true);
    assert.strictEqual((await store.getDefaultForOrg('org1')).id, created.id);
    assert.strictEqual(rows.find(r => r.id === 'a').is_default, false);
});

test('create without makeDefault leaves the existing default alone', async () => {
    const created = await store.create({ orgId: 'org1', name: 'Plain', docxBuffer: Buffer.from('x'), styleMeta: {} });
    assert.strictEqual(created.isDefault, false);
    assert.strictEqual((await store.getDefaultForOrg('org1')).id, 'a');
});
