/**
 * core/projectContent/itemLifecycle.js — what happens to an item's
 * project-bound state (co-editing, comment threads, compliance signal) when it
 * leaves its project or is deleted, over recording stand-ins.
 *
 * Proven: each step runs with ids only; a failing step never stops the next
 * or reaches the caller; co-editing state is folded back BEFORE a move only
 * for a caller the stores will let move the item; anything that is not a
 * notebook or document is left alone.
 *
 * Run: cd server && node --test core/projectContent/itemLifecycle.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeItemLifecycle } = require('./itemLifecycle');

function world({ where = null, failing = [] } = {}) {
    const calls = [];
    const maybeFail = (name) => { if (failing.includes(name)) throw new Error(`${name} down`); };
    const lc = makeItemLifecycle({
        collab: {
            detach: async (kind, id, opts) => { calls.push(['detach', kind, id, opts.reason]); maybeFail('detach'); return { detached: 1 }; },
            detachProject: async (projectId) => { calls.push(['detachProject', projectId]); return { detached: 2, failed: 0 }; },
        },
        comments: {
            deleteForTarget: async (type, id) => { calls.push(['threads', type, id]); maybeFail('threads'); return 3; },
            deleteForTargetInProject: async (pid, type, id) => { calls.push(['threadsIn', pid, type, id]); return 1; },
        },
        signals: { deleteSignal: async (subject, id) => { calls.push(['signal', subject, id]); } },
        placement: async () => where,
        log: { warn() {} },
    });
    return { lc, calls };
}

test('deleted: co-editing state, every thread on the item and its signal go', async () => {
    const { lc, calls } = world();
    assert.deepStrictEqual(await lc.deleted('notebook', 'nb1'), { threads: 3 });
    assert.deepStrictEqual(calls, [
        ['detach', 'notebook', 'nb1', 'deleted'],
        ['threads', 'notebook', 'nb1'],
        ['signal', 'notebook_document', 'nb1'],
    ]);
});

test('a failing step is logged and the rest still run', async () => {
    const { lc, calls } = world({ failing: ['detach', 'threads'] });
    assert.deepStrictEqual(await lc.deleted('document', 'd1'), { threads: 0 });
    assert.deepStrictEqual(calls.map((c) => c[0]), ['detach', 'threads', 'signal']);
    assert.deepStrictEqual(calls.at(-1), ['signal', 'studio_document', 'd1']);
});

test('leftProject: only that project\'s threads go', async () => {
    const { lc, calls } = world();
    assert.deepStrictEqual(await lc.leftProject('document', 'd1', 'p1'), { threads: 1 });
    assert.deepStrictEqual(calls, [
        ['detach', 'document', 'd1', 'detached'],
        ['threadsIn', 'p1', 'document', 'd1'],
        ['signal', 'studio_document', 'd1'],
    ]);
});

test('beforeMove folds back only when the item really leaves, for its owner or the project owner taking it out', async () => {
    const filed = { projectId: 'p1', ownerId: 'ann' };
    const detaches = async (move) => {
        const { lc, calls } = world({ where: filed });
        const where = await lc.beforeMove({ kind: 'notebook', id: 'nb1', fromProjectId: 'p1', ...move });
        assert.deepStrictEqual(where, filed);
        return calls.some((c) => c[0] === 'detach');
    };
    assert.strictEqual(await detaches({ userId: 'ann', targetProjectId: null }), true, 'the owner takes it out');
    assert.strictEqual(await detaches({ userId: 'ann', targetProjectId: 'p2' }), true, 'the owner moves it to another project');
    assert.strictEqual(await detaches({ userId: 'olga', targetProjectId: null, projectRole: 'owner' }), true, 'the project owner takes it out');
    assert.strictEqual(await detaches({ userId: 'ann', targetProjectId: 'p1' }), false, 'filed where it already is');
    assert.strictEqual(await detaches({ userId: 'eve', targetProjectId: null, projectRole: 'editor' }), false,
        'a request the store will refuse cannot close anybody\'s co-editing session');
    assert.strictEqual(await detaches({ userId: 'eve', targetProjectId: 'p2' }), false, 'not hers to move');
});

test('beforeDelete folds back for the owner only; beforeProjectDeleted folds back the whole project', async () => {
    const own = world({ where: { projectId: 'p1', ownerId: 'ann' } });
    assert.strictEqual(await own.lc.beforeDelete('document', 'd1', 'ann'), 1);
    assert.deepStrictEqual(own.calls, [['detach', 'document', 'd1', 'deleted']]);
    const other = world({ where: { projectId: 'p1', ownerId: 'ann' } });
    assert.strictEqual(await other.lc.beforeDelete('document', 'd1', 'eve'), 0);
    assert.deepStrictEqual(other.calls, []);
    const unfiled = world({ where: { projectId: null, ownerId: 'ann' } });
    assert.strictEqual(await unfiled.lc.beforeDelete('document', 'd1', 'ann'), 0, 'not co-edited outside a project');

    const p = world();
    assert.strictEqual(await p.lc.beforeProjectDeleted('p1'), 2);
    assert.deepStrictEqual(p.calls, [['detachProject', 'p1']]);
});

test('other kinds are left alone', async () => {
    const { lc, calls } = world({ where: { projectId: 'p1', ownerId: 'ann' } });
    await lc.deleted('meeting', 'm1');
    await lc.leftProject('automation', 'a1', 'p1');
    assert.strictEqual(await lc.beforeMove({ kind: 'app', id: 'x', userId: 'ann', targetProjectId: null, fromProjectId: 'p1' }), null);
    assert.deepStrictEqual(calls, []);
});
