/**
 * stores/user/projectErasure.js — the collaborative-project half of account
 * erasure: every step runs, in order, and one failing store does not stop the
 * others (the same rule as the rest of deleteUser).
 *
 * Run: cd server && node --test stores/user/projectErasure.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { eraseProjectTraces, eraseOwnedProjects } = require('./projectErasure');

test('every step runs with the user id, and a failing one is reported without stopping the rest', async () => {
    const seen = [];
    const report = await eraseProjectTraces('u1', {
        steps: [
            ['team chat messages', async (id) => { seen.push(['chat', id]); return { messages: 2 }; }],
            ['comments', async () => { seen.push(['comments']); throw new Error('table missing'); }],
            ['co-editing log', async (id) => { seen.push(['collab', id]); return { updates: 3 }; }],
        ],
    });
    assert.deepStrictEqual(seen, [['chat', 'u1'], ['comments'], ['collab', 'u1']]);
    assert.deepStrictEqual(report, {
        'team chat messages': { messages: 2 },
        comments: { failed: true },
        'co-editing log': { updates: 3 },
    });
});

test('no user id erases nothing', async () => {
    let ran = false;
    const report = await eraseProjectTraces('', { steps: [['x', async () => { ran = true; }]] });
    assert.deepStrictEqual(report, {});
    assert.strictEqual(ran, false);
});

test('the default steps cover every store that keeps a person in a colleague\'s project', async () => {
    // Every default step fails here (no database); what matters is that each
    // one is attempted and named, so none can be dropped by accident.
    const report = await eraseProjectTraces('nobody-' + Date.now());
    assert.deepStrictEqual(Object.keys(report), [
        'team chat messages', 'comments', 'co-editing log', 'change feed state',
        'AI participation', 'AI participation preference', 'compliance hint dismissals',
    ]);
});

test('owned projects are deleted one by one through the teardown; one with a shared chat is kept untouched', async () => {
    // A bare DELETE by owner cascaded colleagues' unsaved co-edits away and
    // orphaned the files base; the teardown folds back and removes the base.
    const tornDown = [];
    const report = await eraseOwnedProjects('u1', {
        listOwned: async (id) => { assert.strictEqual(id, 'u1'); return ['p1', 'p-shared', 'p-broken', 'p-gone']; },
        countSharedThreads: async (projectId) => (projectId === 'p-shared' ? 2 : 0),
        handOver: async () => null,
        teardown: {
            deleteProject: async (projectId) => {
                tornDown.push(projectId);
                if (projectId === 'p-broken') throw new Error('db down');
                return projectId !== 'p-gone';
            },
        },
    });
    assert.deepStrictEqual(tornDown, ['p1', 'p-broken', 'p-gone'], 'the project with a shared chat is not folded back, detached or deleted');
    assert.deepStrictEqual(report, { deleted: 1, kept: 1, failed: 1, handedOver: 0 });
});

test('a project others edit in is handed to an editor, not deleted with their chats, comments and tasks', async () => {
    const tornDown = [];
    const report = await eraseOwnedProjects('u1', {
        listOwned: async () => ['p-team', 'p-solo'],
        countSharedThreads: async () => 0,
        handOver: async (projectId, from) => { assert.strictEqual(from, 'u1'); return projectId === 'p-team' ? 'u2' : null; },
        teardown: { deleteProject: async (projectId) => { tornDown.push(projectId); return true; } },
    });
    assert.deepStrictEqual(tornDown, ['p-solo'], 'only the project nobody else edits in is torn down');
    assert.deepStrictEqual(report, { deleted: 1, kept: 0, failed: 0, handedOver: 1 });
});

test('owned projects: no user id, or a listing that fails, deletes nothing', async () => {
    let asked = false;
    const teardown = { deleteProject: async () => { asked = true; return true; } };
    assert.deepStrictEqual(await eraseOwnedProjects('', { listOwned: async () => ['p1'], countSharedThreads: async () => 0, handOver: async () => null, teardown }),
        { deleted: 0, kept: 0, failed: 0, handedOver: 0 });
    assert.deepStrictEqual(await eraseOwnedProjects('u1', {
        listOwned: async () => { throw new Error('relation "projects" does not exist'); }, countSharedThreads: async () => 0, handOver: async () => null, teardown,
    }), { deleted: 0, kept: 0, failed: 1, handedOver: 0 });
    assert.strictEqual(asked, false);
});

// ── Solution stages ──────────────────────────────────────────────────

const hasStages = () => Object.assign(new Error('This Solution has stages.'), { status: 409, code: 'solution_has_stages', expose: true });

test('a stage project, or a Dev with stages, is kept: neither handed over nor torn down', async () => {
    const handed = [];
    const tornDown = [];
    const report = await eraseOwnedProjects('u1', {
        listOwned: async () => ['p-dev', 'p-uat', 'p-plain'],
        countSharedThreads: async () => 0,
        handOver: async (projectId) => { handed.push(projectId); return null; },
        teardown: {
            teardownRefusal: async (projectId) => (projectId === 'p-plain' ? null : hasStages()),
            deleteProject: async (projectId) => { tornDown.push(projectId); return true; },
        },
    });
    assert.deepStrictEqual(handed, ['p-plain'], 'a refused project is not even offered to an heir');
    assert.deepStrictEqual(tornDown, ['p-plain']);
    assert.deepStrictEqual(report, { deleted: 1, kept: 2, failed: 0, handedOver: 0 });
});

test('a remove deployment\'s capability reaches the teardown\'s check and its delete', async () => {
    const removal = { deploymentId: 'dep-rm' };
    const seen = [];
    const report = await eraseOwnedProjects('u1', {
        listOwned: async () => ['p-uat'],
        countSharedThreads: async () => 0,
        handOver: async () => null,
        removal,
        teardown: {
            teardownRefusal: async (projectId, opts) => { seen.push(['check', projectId, opts.removal]); return opts.removal ? null : hasStages(); },
            deleteProject: async (projectId, opts) => { seen.push(['delete', projectId, opts.removal]); return true; },
        },
    });
    assert.deepStrictEqual(seen, [['check', 'p-uat', removal], ['delete', 'p-uat', removal]]);
    assert.deepStrictEqual(report, { deleted: 1, kept: 0, failed: 0, handedOver: 0 });
});

test('the default teardown asks the stage question first', () => {
    const { makeProjectTeardown } = require('../../projects/projectTeardown');
    assert.strictEqual(typeof makeProjectTeardown().teardownRefusal, 'function');
});
