/**
 * teamsImportSkipState tests: the poller's skip state is written only when it
 * changes, deleted only when something is stored, read back in one batch, and
 * a storage failure never escapes record/clear.
 *
 * Run: cd server && node --test core/meetingNotes/teamsImportSkipState.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const skip = require('./teamsImportSkipState.mts');

function fakeStore() {
    const docs = new Map();
    const calls = { set: 0, del: 0, batch: [] };
    return {
        docs, calls,
        getConfig: async (k) => (docs.has(k) ? structuredClone(docs.get(k)) : null),
        setConfig: async (k, v) => { calls.set += 1; docs.set(k, structuredClone(v)); },
        deleteConfig: async (k) => { calls.del += 1; return docs.delete(k); },
        getConfigsByKeys: async (keys) => {
            calls.batch.push(keys);
            const out = {};
            for (const k of keys) if (docs.has(k)) out[k] = structuredClone(docs.get(k));
            return out;
        },
    };
}

test.afterEach(() => skip.init({}));

test('the key is the per-user stem account erasure deletes', () => {
    assert.equal(skip.SKIP_STATE_STEM, 'teams_autoimport_skip');
    assert.equal(skip.skipStateKey('u1'), 'teams_autoimport_skip_user_u1');
});

test('recordSkip writes once per change, keeps the first time, and rewrites on a new reason, list or org', async () => {
    const store = fakeStore();
    skip.init({ configStore: store });
    await skip.recordSkip('u1', 'o1', 'missing_scopes', ['OnlineMeetingRecording.Read.All']);
    assert.equal(store.calls.set, 1);
    const first = store.docs.get('teams_autoimport_skip_user_u1');
    assert.deepEqual({ ...first, at: 'x' }, { reason: 'missing_scopes', missingPermissions: ['OnlineMeetingRecording.Read.All'], at: 'x', orgId: 'o1' });
    assert.ok(!Number.isNaN(Date.parse(first.at)));

    await skip.recordSkip('u1', 'o1', 'missing_scopes', ['OnlineMeetingRecording.Read.All']);
    assert.equal(store.calls.set, 1, 'same state: no write');

    await skip.recordSkip('u1', 'o1', 'missing_scopes', ['Calendars.ReadWrite', 'OnlineMeetingRecording.Read.All']);
    assert.equal(store.calls.set, 2, 'other missing list: written');
    await skip.recordSkip('u1', 'o1', 'no_credential');
    assert.equal(store.calls.set, 3, 'other reason: written');
    assert.deepEqual(store.docs.get('teams_autoimport_skip_user_u1').missingPermissions, []);
    await skip.recordSkip('u1', 'o2', 'no_credential');
    assert.equal(store.calls.set, 4, 'moved to another org: written, so the new org sees it');
    await skip.recordSkip('u1', 'o2', 'no_credential');
    assert.equal(store.calls.set, 4);
});

test('recordSkip ignores an unknown reason', async () => {
    const store = fakeStore();
    skip.init({ configStore: store });
    await skip.recordSkip('u1', 'o1', 'made_up');
    assert.equal(store.calls.set, 0);
});

test('clearSkip deletes only when something is stored', async () => {
    const store = fakeStore();
    skip.init({ configStore: store });
    await skip.clearSkip('u1');
    assert.equal(store.calls.del, 0, 'nothing stored: no delete');
    await skip.recordSkip('u1', null, 'session_unavailable');
    await skip.clearSkip('u1');
    assert.equal(store.calls.del, 1);
    assert.equal(store.docs.has('teams_autoimport_skip_user_u1'), false);
    await skip.clearSkip('u1');
    assert.equal(store.calls.del, 1);
});

test('readSkips reads every user in one batch and drops documents that are not a skip state', async () => {
    const store = fakeStore();
    skip.init({ configStore: store });
    await skip.recordSkip('u1', 'o1', 'not_licensed');
    await skip.recordSkip('u2', 'o1', 'missing_scopes', ['Calendars.ReadWrite']);
    store.docs.set('teams_autoimport_skip_user_u3', { reason: 'whatever' });
    const out = await skip.readSkips(['u1', 'u2', 'u3', 'u4', 'u1']);
    assert.equal(store.calls.batch.length, 1);
    assert.deepEqual(store.calls.batch[0], ['teams_autoimport_skip_user_u1', 'teams_autoimport_skip_user_u2', 'teams_autoimport_skip_user_u3', 'teams_autoimport_skip_user_u4']);
    assert.deepEqual([...out.keys()], ['u1', 'u2']);
    assert.equal(out.get('u1').reason, 'not_licensed');
    assert.equal(out.get('u1').orgId, 'o1');
    assert.deepEqual(out.get('u2').missingPermissions, ['Calendars.ReadWrite']);
    assert.equal((await skip.readSkips([])).size, 0);
    assert.equal(store.calls.batch.length, 1, 'no ids: no read');
});

test('a storage failure is logged, never thrown, by record and clear', async () => {
    const broken = {
        getConfig: async () => { throw new Error('db down'); },
        setConfig: async () => { throw new Error('db down'); },
        deleteConfig: async () => { throw new Error('db down'); },
        getConfigsByKeys: async () => ({}),
    };
    skip.init({ configStore: broken });
    await skip.recordSkip('u1', 'o1', 'no_credential');
    await skip.clearSkip('u1');
});
