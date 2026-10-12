/**
 * projectStore.transferOwner against a real Postgres (pglite): the owner moves, the target's own
 * share goes, the old owner stays on as asked, a stale `fromUserId` writes nothing, stages refuse.
 *
 * Run: cd server && node --test stores/projectStore.transfer.test.js
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { openPgliteProjectStore } = require('../testUtils/pgliteProjectStore');

let pg;
let store;

before(async () => { ({ pg, store } = await openPgliteProjectStore()); });
after(async () => { await pg.close(); });

const sharesOf = async (id) => (await pg.query(
    'SELECT shared_with_id AS who, permission FROM project_shares WHERE project_id = $1 ORDER BY shared_with_id', [id],
)).rows;

async function fresh() {
    const p = await store.createProject({ name: 'P', ownerId: 'alice' });
    await store.shareProject(p.id, 'user', 'bob', 'editor');
    return p;
}

test('the owner moves, the target share goes, the old owner stays as editor', async () => {
    const p = await fresh();
    const before = await pg.query('SELECT version FROM projects WHERE id = $1', [p.id]);
    const out = await store.transferOwner({ projectId: p.id, fromUserId: 'alice', toUserId: 'bob', keepFromAs: 'editor' });
    assert.deepStrictEqual(out, { ok: true });
    assert.strictEqual((await store.getProject(p.id)).ownerId, 'bob');
    assert.deepStrictEqual(await sharesOf(p.id), [{ who: 'alice', permission: 'editor' }]);
    const after = await pg.query('SELECT version FROM projects WHERE id = $1', [p.id]);
    assert.strictEqual(after.rows[0].version, (before.rows[0].version || 0) + 1);
});

test('keepFromAs viewer keeps a viewer, none keeps nobody', async () => {
    const a = await fresh();
    await store.transferOwner({ projectId: a.id, fromUserId: 'alice', toUserId: 'bob', keepFromAs: 'viewer' });
    assert.deepStrictEqual(await sharesOf(a.id), [{ who: 'alice', permission: 'viewer' }]);
    const b = await fresh();
    await store.transferOwner({ projectId: b.id, fromUserId: 'alice', toUserId: 'bob', keepFromAs: 'none' });
    assert.deepStrictEqual(await sharesOf(b.id), []);
});

test('a stale owner writes nothing', async () => {
    const p = await fresh();
    const out = await store.transferOwner({ projectId: p.id, fromUserId: 'mallory', toUserId: 'bob', keepFromAs: 'editor' });
    assert.deepStrictEqual(out, { ok: false, reason: 'owner_changed' });
    assert.strictEqual((await store.getProject(p.id)).ownerId, 'alice');
    assert.deepStrictEqual(await sharesOf(p.id), [{ who: 'bob', permission: 'editor' }]);
});

test('a stage-bound project refuses with 409', async () => {
    const dev = await store.createProject({ name: 'Dev', ownerId: 'alice', kind: 'solution' });
    const uat = await store.createStageProject(null, { devProject: dev, stage: 'uat', ownerId: 'alice' });
    await assert.rejects(store.transferOwner({ projectId: uat.id, fromUserId: 'alice', toUserId: 'bob' }),
        (e) => e.status === 409 && e.code === 'stage_project');
    assert.strictEqual((await store.getProject(uat.id)).ownerId, 'alice');
});
