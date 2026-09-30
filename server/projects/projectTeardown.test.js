/**
 * projects/projectTeardown.js — the one order a project delete may take, for
 * the delete route and for account erasure alike. Dependencies are injected
 * (no module mocking, no database).
 *
 * Proven:
 *   - co-edited state is folded back BEFORE the soft references are detached
 *     and before the row is deleted; the files base goes only AFTER the row;
 *   - a detacher, the fold-back or the files base failing does not stop the
 *     delete, and is logged with ids only;
 *   - a refused delete (a chat shared into the project in between) is thrown
 *     to the caller and keeps the files base;
 *   - a project without a files base is not asked to remove one.
 *
 * Run: cd server && node --test projects/projectTeardown.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeProjectTeardown } = require('./projectTeardown');

function harness({ project = { id: 'p1', filesKbId: 'kb1', name: 'Launch' }, deleteThrows = null, failing = [] } = {}) {
    const calls = [];
    const warned = [];
    const fail = (what) => { if (failing.includes(what)) throw new Error(`${what} down`); };
    const teardown = makeProjectTeardown({
        store: {
            getProject: async (id) => { calls.push(['getProject', id]); return project; },
            deleteProject: async (id) => {
                calls.push(['deleteProject', id]);
                if (deleteThrows) throw deleteThrows;
                return true;
            },
        },
        lifecycle: { beforeProjectDeleted: async (id) => { calls.push(['foldBack', id]); fail('foldBack'); return 2; } },
        membership: {
            detachableKinds: () => [
                { section: 'notebooks', clearProject: async (id) => { calls.push(['detach:notebooks', id]); fail('notebooks'); } },
                { section: 'automations', clearProject: async (id) => { calls.push(['detach:automations', id]); } },
            ],
        },
        removeFilesKb: async (p) => { calls.push(['removeFilesKb', p.id]); fail('files'); return true; },
        log: { warn: (...args) => warned.push(args.join(' ')) },
    });
    return { teardown, calls, warned };
}

test('fold back, detach, delete, then the files base: in that order', async () => {
    const h = harness();
    assert.strictEqual(await h.teardown.deleteProject('p1'), true);
    assert.deepStrictEqual(h.calls, [
        ['foldBack', 'p1'],
        ['detach:notebooks', 'p1'],
        ['detach:automations', 'p1'],
        ['getProject', 'p1'],
        ['deleteProject', 'p1'],
        ['removeFilesKb', 'p1'],
    ]);
    assert.deepStrictEqual(h.warned, []);
});

test('a failing step is logged with ids only and never stops the delete', async () => {
    const h = harness({ failing: ['foldBack', 'notebooks', 'files'] });
    assert.strictEqual(await h.teardown.deleteProject('p1'), true);
    assert.ok(h.calls.some(([c]) => c === 'deleteProject'));
    assert.ok(h.calls.some(([c]) => c === 'detach:automations'), 'the next detacher still runs');
    assert.strictEqual(h.warned.length, 3);
    for (const line of h.warned) assert.doesNotMatch(line, /Launch/, 'no project name in the log');
});

test('a refused delete is thrown to the caller and keeps the files base', async () => {
    const refusal = Object.assign(new Error('violates check constraint "shared_needs_project"'), { code: '23514' });
    const h = harness({ deleteThrows: refusal });
    await assert.rejects(h.teardown.deleteProject('p1'), refusal);
    assert.ok(!h.calls.some(([c]) => c === 'removeFilesKb'));
});

test('a project without a files base is not asked to remove one; no id deletes nothing', async () => {
    const h = harness({ project: { id: 'p1', filesKbId: null } });
    await h.teardown.deleteProject('p1');
    assert.ok(!h.calls.some(([c]) => c === 'removeFilesKb'));
    const none = harness();
    assert.strictEqual(await none.teardown.deleteProject(''), false);
    assert.deepStrictEqual(none.calls, []);
});
