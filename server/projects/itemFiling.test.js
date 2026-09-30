/**
 * projects/itemFiling.js — filing an item into a project or taking it out
 * (PUT /api/projects/:id/resources): one feed entry per project the item
 * entered or left, the project-bound state of an item that left, and nothing
 * at all for a refused move or an item filed where it already was.
 *
 * Run: cd server && node --test projects/itemFiling.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeItemFiling } = require('./itemFiling');

function world({ where = null, moves = true } = {}) {
    const calls = [];
    const filing = makeItemFiling({
        feed: {
            recordProjectChange: async (pid, actor, action, details) => { calls.push(['change', pid, action, details.targetType, details.targetId]); },
            recordItemMoved: async (e) => { calls.push(['moved', e.projectId, e.direction, e.itemType, e.itemId, e.actorId]); },
        },
        lifecycle: {
            beforeMove: async (m) => { calls.push(['beforeMove', m.targetProjectId, m.fromProjectId]); return where; },
            leftProject: async (kind, id, pid) => { calls.push(['left', kind, id, pid]); },
        },
    });
    const entry = { setProject: async (id, userId, target) => { calls.push(['setProject', id, target]); return moves; } };
    return { filing, entry, calls };
}

const file = (w, kind, attach, projectId = 'p1') => w.filing.fileItem({
    entry: w.entry, kind, id: 'x1', userId: 'ann', projectId, attach, req: { projectRole: 'editor' },
});

test('a notebook filed in: one content.moved_in, folded back first', async () => {
    const w = world({ where: { projectId: null, ownerId: 'ann' } });
    assert.strictEqual(await file(w, 'notebook', true), true);
    assert.deepStrictEqual(w.calls, [
        ['beforeMove', 'p1', 'p1'],
        ['setProject', 'x1', 'p1'],
        ['moved', 'p1', 'in', 'notebook', 'x1', 'ann'],
    ]);
});

test('moved straight from another project: in here, out there, and that project\'s state goes', async () => {
    const w = world({ where: { projectId: 'p0', ownerId: 'ann' } });
    await file(w, 'document', true);
    assert.deepStrictEqual(w.calls.slice(2), [
        ['moved', 'p1', 'in', 'document', 'x1', 'ann'],
        ['moved', 'p0', 'out', 'document', 'x1', 'ann'],
        ['left', 'document', 'x1', 'p0'],
    ]);
});

test('taken out: content.moved_out and the project-bound state goes', async () => {
    const w = world({ where: { projectId: 'p1', ownerId: 'ann' } });
    await file(w, 'notebook', false);
    assert.deepStrictEqual(w.calls, [
        ['beforeMove', null, 'p1'],
        ['setProject', 'x1', null],
        ['moved', 'p1', 'out', 'notebook', 'x1', 'ann'],
        ['left', 'notebook', 'x1', 'p1'],
    ]);
});

test('filed where it already is, or refused by the store: nothing is recorded', async () => {
    const same = world({ where: { projectId: 'p1', ownerId: 'ann' } });
    assert.strictEqual(await file(same, 'notebook', true), true);
    assert.deepStrictEqual(same.calls.map((c) => c[0]), ['beforeMove', 'setProject']);
    const refused = world({ where: { projectId: null, ownerId: 'bob' }, moves: false });
    assert.strictEqual(await file(refused, 'notebook', true), false);
    assert.deepStrictEqual(refused.calls.map((c) => c[0]), ['beforeMove', 'setProject']);
});

test('a meeting is followed by the change feed; other kinds keep resource_added / resource_removed', async () => {
    const meeting = world();
    await file(meeting, 'meeting', true);
    assert.deepStrictEqual(meeting.calls.at(-1), ['moved', 'p1', 'in', 'meeting', 'x1', 'ann']);
    const app = world();
    await file(app, 'app', true);
    await file(app, 'app', false);
    assert.deepStrictEqual(app.calls.filter((c) => c[0] === 'change'), [
        ['change', 'p1', 'resource_added', 'app', 'x1'],
        ['change', 'p1', 'resource_removed', 'app', 'x1'],
    ]);
    assert.ok(!app.calls.some((c) => c[0] === 'left'), 'no project-bound state to clear for an app');
});
