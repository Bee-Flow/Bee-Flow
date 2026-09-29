/**
 * The automation routes answer each role as automation/access.js says
 * (handoff 5, sharing and roles): crud, runs, versions and run operations,
 * mounted on a real Express app.
 *
 * No module mocking: the routes call their store and the user lookups
 * through the module objects at request time, so this file swaps a few
 * functions ON those objects for the duration of the run (and puts them
 * back), the way a store's init seam would.
 *
 * The cast, all in org1 unless said otherwise:
 *   owner     owns a1
 *   ed        user share, edit
 *   vic       group share (g-fin), view
 *   ron       user share, run
 *   adm       org admin with manage_automations
 *   stranger  same organisation, no share
 *   outsider  another organisation, with a share row (grants nothing)
 *
 * Run: cd server && node --test routes/automation/access.routes.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const automationStore = require('../../stores/automationStore');
const userStore = require('../../stores/userStore');
const permissions = require('../../auth/permissions');
const { serve } = require('../../core/http/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');

const USERS = {
    owner: { id: 'owner', organizationId: 'org1', groups: [] },
    ed: { id: 'ed', organizationId: 'org1', groups: [] },
    vic: { id: 'vic', organizationId: 'org1', groups: ['g-fin'] },
    ron: { id: 'ron', organizationId: 'org1', groups: [] },
    adm: { id: 'adm', organizationId: 'org1', groups: [] },
    stranger: { id: 'stranger', organizationId: 'org1', groups: [] },
    outsider: { id: 'outsider', organizationId: 'org2', groups: [] },
};
const A1 = {
    id: 'a1', userId: 'owner', organizationId: 'org1', title: 'Invoices', kind: 'automation',
    definition: { trigger: { kind: 'manual', id: 't' }, steps: [{ id: 's1', type: 'note' }] },
    builderSession: { turns: 2 }, version: 3, liveVersion: 2, isActive: true, updatedAt: '2026-09-01T00:00:00.000Z',
};
const SHARES = [
    { principalType: 'user', principalId: 'ed', role: 'edit' },
    { principalType: 'group', principalId: 'g-fin', role: 'view' },
    { principalType: 'user', principalId: 'ron', role: 'run' },
    { principalType: 'user', principalId: 'outsider', role: 'edit' },
];
const RUNS = {
    'run-ron': { id: 'run-ron', automationId: 'a1', userId: 'owner', startedByUserId: 'ron', status: 'success' },
    'run-owner': { id: 'run-owner', automationId: 'a1', userId: 'owner', startedByUserId: 'owner', status: 'success' },
    'run-ron-test': { id: 'run-ron-test', automationId: 'a1', userId: 'owner', startedByUserId: 'ron', status: 'success', mode: 'live', triggerKind: 'manual', isTest: true },
};

const seen = { runFilters: [], sharedArgs: [], executed: [] };
const { swap, restore } = makeSwaps();

let api;

before(() => {
    swap(automationStore, 'getAutomation', async (id) => (id === 'a1' ? JSON.parse(JSON.stringify(A1)) : null));
    swap(automationStore, 'listSharesForAutomation', async (id) => (id === 'a1' ? SHARES : []));
    swap(automationStore, 'getAutomationsForUser', async (userId) => (userId === 'owner' ? [JSON.parse(JSON.stringify(A1))] : []));
    swap(automationStore, 'listAutomationsSharedWithUser', async (userId, opts) => {
        seen.sharedArgs.push([userId, opts]);
        return userId === 'vic'
            ? [{ ...JSON.parse(JSON.stringify(A1)), myRole: 'view', owner: { userId: 'owner', name: 'Olga' } }]
            : [];
    });
    swap(automationStore, 'listRunsForAutomation', async (id, filters) => { seen.runFilters.push(filters); return { runs: [], nextCursor: null }; });
    swap(automationStore, 'getRun', async (id) => (RUNS[id] ? { ...RUNS[id] } : null));
    swap(automationStore, 'getLatestRunInChain', async () => null);
    swap(automationStore, 'listVersions', async () => []);
    swap(automationStore, 'getWebhooksForAutomation', async () => []);
    swap(userStore, 'getUser', async (id) => USERS[id] || null);
    swap(permissions, 'hasPermission', async (id, perm) => perm === 'manage_automations' && id === 'adm');
    swap(automationStore, 'getRunSteps', async () => []);
    // The runner itself is not what this file is about: record what was started.
    swap(require('../../core/automationRunner'), 'executeAutomation', async (a, opts) => {
        seen.executed.push({ id: a.id, opts });
        return { id: `run-x${seen.executed.length}`, status: 'success' };
    });

    api = serve('/', [require('./crud'), require('./runs'), require('./versions'), require('./webhooksAndRunOps')]);
});

after(async () => {
    restore();
    await api.close();
});

// The session carries the id alone: the routes look the rest up (org, groups).
const call = (method, path, { as, body }) => api.call(method, path, { body, user: { id: as } });

// Only the REFUSALS go through the heavier handlers: an allowed PUT or
// DELETE would reach validation, subscriptions and the knowledge-base index,
// which are not what this file is about. Every refusal must happen before
// any of that.
const DENIALS = [
    // [method, path, body, who is refused]
    ['GET', '/a1', undefined, ['stranger', 'outsider']],
    ['GET', '/a1/versions', undefined, ['ron', 'stranger', 'outsider']],
    ['GET', '/a1/webhooks', undefined, ['vic', 'ron', 'stranger']],
    ['GET', '/a1/export', undefined, ['ron', 'stranger']],
    ['PUT', '/a1', { title: 'Renamed' }, ['vic', 'ron', 'stranger', 'outsider']],
    ['DELETE', '/a1', undefined, ['ed', 'vic', 'ron', 'stranger']],
    ['POST', '/a1/activate', undefined, ['vic', 'ron', 'stranger']],
    ['POST', '/a1/publish', undefined, ['vic', 'ron', 'stranger']],
    ['POST', '/a1/deactivate', undefined, ['vic', 'ron', 'stranger']],
    ['POST', '/a1/steps/s1/run', undefined, ['vic', 'ron', 'stranger']],
    ['POST', '/a1/run', undefined, ['stranger', 'outsider']],
    // The working copy (Test button, dry run, one step) is an editor's tool;
    // `run` starts the live version only.
    ['POST', '/a1/run', { test: true }, ['vic', 'ron', 'stranger', 'outsider']],
    ['POST', '/a1/dry-run', undefined, ['vic', 'ron', 'stranger']],
    ['GET', '/a1/runs', undefined, ['stranger', 'outsider']],
    ['POST', '/a1/versions/v1/restore', undefined, ['vic', 'ron', 'stranger']],
    ['POST', '/a1/webhook', undefined, ['vic', 'ron']],
    ['POST', '/a1/form', undefined, ['vic', 'ron']],
    ['GET', '/a1/forms', undefined, ['ron', 'stranger']],
    ['POST', '/a1/diagnose-trigger', undefined, ['vic', 'ron']],
];

test('every route refuses the roles below its need with 403, before doing anything', async () => {
    for (const [method, path, body, refused] of DENIALS) {
        for (const who of refused) {
            const res = await call(method, path, { as: who, body });
            assert.strictEqual(res.status, 403, `${method} ${path} as ${who}: ${JSON.stringify(res.body)}`);
            assert.strictEqual(res.body.code, 'automation_forbidden', `${method} ${path} as ${who}`);
        }
    }
});

test('GET /:id: every role that may see it, with myRole; run-only gets the triggers alone', async () => {
    const expect = { owner: 'owner', adm: 'owner', ed: 'edit', vic: 'view', ron: 'run' };
    for (const [who, role] of Object.entries(expect)) {
        const res = await call('GET', '/a1', { as: who });
        assert.strictEqual(res.status, 200, who);
        assert.strictEqual(res.body.automation.myRole, role, who);
        assert.strictEqual(res.body.automation.accessVia, who === 'owner' ? 'owner' : who === 'adm' ? 'admin' : 'share');
    }
    const own = await call('GET', '/a1', { as: 'owner' });
    assert.deepStrictEqual(own.body.automation.builderSession, { turns: 2 });
    const editor = await call('GET', '/a1', { as: 'ed' });
    assert.strictEqual(editor.body.automation.builderSession, null, "the owner's builder chat stays theirs");
    assert.ok(editor.body.summary !== undefined);
    const runner = await call('GET', '/a1', { as: 'ron' });
    assert.deepStrictEqual(runner.body.automation.definition, { trigger: { kind: 'manual', id: 't' } });
    assert.strictEqual(runner.body.automation.definitionRedacted, true);
    assert.strictEqual(runner.body.summary, null);
});

test('PUT /:id: an editor may not move the routine into a folder', async () => {
    const res = await call('PUT', '/a1', { as: 'ed', body: { folderId: 'f1' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.need, 'owner');
});

test('GET /:id/runs: view reads every run, run-only only the runs they started', async () => {
    seen.runFilters.length = 0;
    const viewer = await call('GET', '/a1/runs', { as: 'vic' });
    assert.strictEqual(viewer.status, 200);
    assert.strictEqual(viewer.body.onlyMine, false);
    const runner = await call('GET', '/a1/runs?status=error', { as: 'ron' });
    assert.strictEqual(runner.status, 200);
    assert.strictEqual(runner.body.onlyMine, true);
    assert.strictEqual(seen.runFilters[0].startedByUserId, undefined);
    assert.strictEqual(seen.runFilters[1].startedByUserId, 'ron');
    assert.deepStrictEqual(seen.runFilters[1].status, ['error']);
});

test('GET /runs/:id: a run-only caller reads their own run and nobody else\'s', async () => {
    assert.strictEqual((await call('GET', '/runs/run-ron', { as: 'ron' })).status, 200);
    const other = await call('GET', '/runs/run-owner', { as: 'ron' });
    assert.strictEqual(other.status, 403);
    assert.strictEqual(other.body.need, 'view');
    assert.strictEqual((await call('GET', '/runs/run-owner', { as: 'vic' })).status, 200);
    assert.strictEqual((await call('GET', '/runs/run-owner', { as: 'stranger' })).status, 403);
    assert.strictEqual((await call('GET', '/runs/run-owner', { as: 'owner' })).status, 200);
});

test('run operations: cancel and approve need edit, or (cancel) your own run', async () => {
    const approve = await call('POST', '/runs/run-ron/approve', { as: 'ron', body: {} });
    assert.strictEqual(approve.status, 403);
    const cancelOther = await call('POST', '/runs/run-owner/cancel', { as: 'ron', body: {} });
    assert.strictEqual(cancelOther.status, 403);
    // Their own finished run passes the role check and meets the state check.
    const cancelOwn = await call('POST', '/runs/run-ron/cancel', { as: 'ron', body: {} });
    assert.strictEqual(cancelOwn.status, 409);
});

test('a run-only share starts the LIVE version; the working copy needs edit', async () => {
    seen.executed.length = 0;
    const live = await call('POST', '/a1/run', { as: 'ron', body: {} });
    assert.strictEqual(live.status, 200, JSON.stringify(live.body));
    assert.strictEqual(seen.executed[0].opts.isTest, false);
    assert.strictEqual(seen.executed[0].opts.startedByUserId, 'ron');

    const refused = await call('POST', '/a1/run', { as: 'ron', body: { test: true } });
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.body.need, 'edit');
    const dry = await call('POST', '/a1/dry-run', { as: 'ron', body: {} });
    assert.strictEqual(dry.body.need, 'edit');

    const tested = await call('POST', '/a1/run', { as: 'ed', body: { test: true } });
    assert.strictEqual(tested.status, 200, JSON.stringify(tested.body));
    assert.strictEqual(seen.executed[1].opts.isTest, true);
    const previewed = await call('POST', '/a1/dry-run', { as: 'ed', body: {} });
    assert.strictEqual(previewed.status, 200, JSON.stringify(previewed.body));
    assert.strictEqual(seen.executed[2].opts.mode, 'dry_run');
    assert.strictEqual(seen.executed.length, 3, 'no refusal started a run');
});

test('retry: a run-only share runs their own live run again, not a test run', async () => {
    seen.executed.length = 0;
    const testRetry = await call('POST', '/a1/runs/run-ron-test/retry', { as: 'ron', body: {} });
    assert.strictEqual(testRetry.status, 403);
    assert.strictEqual(testRetry.body.need, 'edit');
    assert.strictEqual(seen.executed.length, 0);
    const liveRetry = await call('POST', '/a1/runs/run-ron/retry', { as: 'ron', body: {} });
    assert.strictEqual(liveRetry.status, 200, JSON.stringify(liveRetry.body));
    assert.strictEqual(seen.executed[0].opts.isTest, false);
    const editorRetry = await call('POST', '/a1/runs/run-ron-test/retry', { as: 'ed', body: {} });
    assert.strictEqual(editorRetry.status, 200, JSON.stringify(editorRetry.body));
    assert.strictEqual(seen.executed[1].opts.isTest, true);
});

test('GET /: the caller\'s own routines and the ones shared with them, each with myRole', async () => {
    const own = await call('GET', '/', { as: 'owner' });
    assert.deepStrictEqual(own.body.automations.map(a => [a.id, a.myRole]), [['a1', 'owner']]);
    const vic = await call('GET', '/', { as: 'vic' });
    assert.strictEqual(vic.status, 200);
    assert.deepStrictEqual(vic.body.automations.map(a => [a.id, a.myRole, a.accessVia]), [['a1', 'view', 'share']]);
    assert.deepStrictEqual(vic.body.automations[0].owner, { userId: 'owner', name: 'Olga' });
    assert.strictEqual(vic.body.automations[0].builderSession, null);
    const [userId, opts] = seen.sharedArgs.find(([u]) => u === 'vic');
    assert.strictEqual(userId, 'vic');
    assert.deepStrictEqual(opts, { orgId: 'org1', groupIds: ['g-fin'] });
});
