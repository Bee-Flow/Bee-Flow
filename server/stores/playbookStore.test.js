'use strict';

/**
 * playbookStore against an in-memory db: owner-only reads, the CAS write
 * (`savePhases` with expectedVersion), and the DDL going through runDdl.
 * Run: node --test --test-force-exit stores/playbookStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let rows = [];
const ddl = [];
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function dispatch(sql, params = []) {
    const s = norm(sql);
    if (/^CREATE (TABLE|INDEX)/i.test(s) || /^ALTER TABLE/i.test(s) || /^SET /i.test(s)) { ddl.push(s); return { rows: [], rowCount: 0 }; }
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(s) || /pg_advisory_xact_lock/.test(s)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO playbooks/.test(s)) {
        const [id, organization_id, user_id, recipe_id, recipe, title, options, phases, current_phase] = params;
        rows.push({ id, organization_id, user_id, recipe_id, recipe, title, status: 'active', options, phases, current_phase, version: 1, created_at: 'T0', updated_at: 'T0' });
        return { rows: [], rowCount: 1 };
    }
    if (/^SELECT \* FROM playbooks WHERE id = \$1 AND user_id = \$2/.test(s)) {
        const r = rows.find((x) => x.id === params[0] && x.user_id === params[1]);
        return { rows: r ? [{ ...r }] : [], rowCount: r ? 1 : 0 };
    }
    if (/^SELECT \* FROM playbooks WHERE user_id = \$1/.test(s)) {
        const list = rows.filter((x) => x.user_id === params[0]).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, params[1]);
        return { rows: list.map((x) => ({ ...x })), rowCount: list.length };
    }
    if (/^UPDATE playbooks SET phases/.test(s)) {
        const [phases, current_phase, status, title, version, id, user_id] = params;
        const r = rows.find((x) => x.id === id && x.user_id === user_id);
        if (!r) return { rows: [], rowCount: 0 };
        Object.assign(r, { phases, current_phase, status, title, version, updated_at: `T${version}` });
        return { rows: [], rowCount: 1 };
    }
    if (/^DELETE FROM playbooks WHERE id = \$1 AND user_id = \$2/.test(s)) {
        const before = rows.length;
        rows = rows.filter((x) => !(x.id === params[0] && x.user_id === params[1]));
        return { rows: [], rowCount: before - rows.length };
    }
    throw new Error('unexpected SQL: ' + s);
}

const mockDb = {
    exec: async (sql) => { dispatch(sql); },
    run: async (sql, params) => dispatch(sql, params),
    getAll: async (sql, params) => dispatch(sql, params).rows,
    getOne: async (sql, params) => dispatch(sql, params).rows[0] || null,
    getClient: async () => ({ query: async (sql, params) => dispatch(sql, params), release: () => {} }),
    withTransaction: async (fn) => fn({ query: async (sql, params) => dispatch(sql, params) }),
    isSqlStateError: (e) => typeof e?.code === 'string' && !!e?.severity,
    makeStoreInit: (tag, fn) => { let p = null; return () => { if (!p) p = Promise.resolve().then(fn).catch((e) => { p = null; throw e; }); return p; }; },
};
const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const store = require('./playbookStore');

test('DDL runs through runDdl and creates the table + the owner index', async () => {
    await store.initDB();
    assert.ok(ddl.some((s) => /CREATE TABLE IF NOT EXISTS playbooks/.test(s)));
    assert.ok(ddl.some((s) => /CREATE INDEX IF NOT EXISTS idx_playbooks_user ON playbooks\(user_id, updated_at DESC\)/.test(s)));
});

test('create → get (owner only) → list, with JSON columns parsed', async () => {
    rows = [];
    const pb = await store.createPlaybook({ userId: 'u1', organizationId: 'org1', recipeId: 'invoice_tracker', title: 'Facturen', options: { tableMode: 'new' }, phases: [{ key: 'table', status: 'ready' }], currentPhase: 'table' });
    assert.match(pb.id, /^pb_[0-9a-f]{12}$/);
    assert.deepEqual(pb.options, { tableMode: 'new' });
    assert.deepEqual(pb.phases, [{ key: 'table', status: 'ready' }]);
    assert.equal(pb.version, 1);
    assert.equal(pb.status, 'active');
    assert.equal(await store.getPlaybook(pb.id, 'u2'), null, 'another user never sees it');
    assert.equal((await store.listPlaybooksForUser('u1')).length, 1);
    assert.equal((await store.listPlaybooksForUser('u2')).length, 0);
    assert.equal((await store.listPlaybooksForUser(null)).length, 0);
});

test('savePhases bumps the version; a stale expectedVersion writes nothing and hands the current row back; an unknown id is notFound', async () => {
    rows = [];
    const pb = await store.createPlaybook({ userId: 'u1', recipeId: 'invoice_tracker', title: 'T', phases: [{ key: 'table', status: 'ready' }] });
    const ok = await store.savePhases(pb.id, 'u1', { phases: [{ key: 'table', status: 'running' }], currentPhase: 'table' }, { expectedVersion: 1 });
    assert.equal(ok.ok, true);
    assert.equal(ok.version, 2);
    assert.deepEqual(ok.playbook.phases, [{ key: 'table', status: 'running' }]);
    const stale = await store.savePhases(pb.id, 'u1', { phases: [{ key: 'table', status: 'failed' }] }, { expectedVersion: 1 });
    assert.deepEqual({ ok: stale.ok, conflict: stale.conflict, currentVersion: stale.currentVersion }, { ok: false, conflict: true, currentVersion: 2 });
    assert.deepEqual(stale.playbook.phases, [{ key: 'table', status: 'running' }], 'nothing was written');
    const untouched = await store.savePhases(pb.id, 'u1', { status: 'stopped' }, { expectedVersion: 2 });
    assert.equal(untouched.playbook.status, 'stopped');
    assert.deepEqual(untouched.playbook.phases, [{ key: 'table', status: 'running' }], 'phases kept when not passed');
    assert.equal(untouched.playbook.title, 'T');
    assert.deepEqual(await store.savePhases('pb_missing', 'u1', { phases: [] }), { ok: false, notFound: true });
    assert.deepEqual(await store.savePhases(pb.id, 'u2', { phases: [] }), { ok: false, notFound: true }, 'another user cannot write it');
});

test('deletePlaybook is owner-only and reports whether a row went', async () => {
    rows = [];
    const pb = await store.createPlaybook({ userId: 'u1', recipeId: 'invoice_tracker', title: 'T' });
    assert.equal(await store.deletePlaybook(pb.id, 'u2'), false);
    assert.equal(await store.deletePlaybook(pb.id, 'u1'), true);
    assert.equal(await store.getPlaybook(pb.id, 'u1'), null);
});
