/**
 * projectStore.setArchived and the archived filter of listUserProjects, against a real Postgres (pglite).
 *
 * Run: cd server && node --test stores/projectStore.archive.test.js
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { openPgliteProjectStore } = require('../testUtils/pgliteProjectStore');

let pg;
let store;

before(async () => { ({ pg, store } = await openPgliteProjectStore()); });
after(async () => { await pg.close(); });

test('a new project is not archived', async () => {
    const p = await store.createProject({ name: 'Live', ownerId: 'alice' });
    const got = await store.getProject(p.id);
    assert.strictEqual(got.archivedAt, null);
    assert.strictEqual(got.archivedBy, null);
});

test('setArchived stamps who and when, and null restores', async () => {
    const p = await store.createProject({ name: 'A', ownerId: 'alice' });
    const archived = await store.setArchived(p.id, 'alice');
    assert.strictEqual(archived.archivedBy, 'alice');
    assert.ok(archived.archivedAt);
    const restored = await store.setArchived(p.id, null);
    assert.strictEqual(restored.archivedAt, null);
    assert.strictEqual(restored.archivedBy, null);
});

test('archiving an archived project keeps the first archivedAt', async () => {
    const p = await store.createProject({ name: 'Twice', ownerId: 'alice' });
    const first = await store.setArchived(p.id, 'alice');
    const second = await store.setArchived(p.id, 'bob');
    assert.strictEqual(String(second.archivedAt), String(first.archivedAt));
    assert.strictEqual(second.archivedBy, 'alice');
});

test('setArchived on an unknown project is null', async () => {
    assert.strictEqual(await store.setArchived('nope', 'alice'), null);
});

test('listUserProjects leaves archived projects out unless asked', async () => {
    const live = await store.createProject({ name: 'Live', ownerId: 'carol' });
    const gone = await store.createProject({ name: 'Gone', ownerId: 'carol' });
    await store.shareProject(gone.id, 'user', 'dave', 'viewer');
    await store.setArchived(gone.id, 'carol');

    assert.deepStrictEqual((await store.listUserProjects('carol')).map(p => p.id), [live.id]);
    assert.deepStrictEqual((await store.listUserProjects('dave')).map(p => p.id), []);
    const all = await store.listUserProjects('carol', [], { includeArchived: true });
    assert.deepStrictEqual(all.map(p => p.id).sort(), [live.id, gone.id].sort());
    assert.ok(all.find(p => p.id === gone.id).archivedAt);
});
