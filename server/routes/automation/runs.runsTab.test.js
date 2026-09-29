/**
 * The Runs tab's endpoints (handoff 5), on a real Express app:
 *   - GET /:id/runs passes q / startedBy / tests to the store, decorates the
 *     rows, and carries the segment counts on the first page only;
 *   - the org log refuses a startedBy filter;
 *   - POST /:id/runs/:runId/retry runs any FINISHED run again (409 otherwise)
 *     with the same input and entry trigger, and answers the new run's id.
 *
 * No module mocking: functions are swapped ON the module objects for the
 * duration of the file and put back after (access.routes.test.js does the same).
 *
 * Run: cd server && node --test routes/automation/runs.runsTab.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { serve } = require('../../core/http/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');
const automationStore = require('../../stores/automationStore');
const userStore = require('../../stores/userStore');
const permissions = require('../../auth/permissions');
const runner = require('../../core/automationRunner');

const A1 = {
    id: 'a1', userId: 'owner', organizationId: 'org1', title: 'Invoices', version: 5, liveVersion: 3,
    definition: { trigger: { id: 't', kind: 'manual' }, steps: [{ id: 's1', type: 'integration_action' }, { id: 's2', type: 'notification' }] },
};
const RUNS = {
    done: { id: 'done', automationId: 'a1', userId: 'owner', status: 'success', triggerKind: 'webhook', triggerPayload: { a: 1 }, rootStepId: 't2', isTest: false, mode: 'live' },
    waiting: { id: 'waiting', automationId: 'a1', userId: 'owner', status: 'success', triggerKind: 'form', mode: 'live' },
    preview: { id: 'preview', automationId: 'a1', userId: 'owner', status: 'error', triggerKind: 'dry_run', mode: 'dry_run', isTest: true },
};
const seen = { listFilters: [], facetFilters: [], executed: [] };
const { swap, restore } = makeSwaps();

let api;

before(() => {
    swap(automationStore, 'getAutomation', async (id) => (id === 'a1' ? JSON.parse(JSON.stringify(A1)) : null));
    swap(automationStore, 'listSharesForAutomation', async () => []);
    swap(automationStore, 'listRunsForAutomation', async (_id, filters) => {
        seen.listFilters.push(filters);
        return {
            runs: [{ id: 'r1', automationId: 'a1', version: 3, status: 'error', triggerKind: 'manual', startedByUserId: 'owner', outcome: { code: 'stopped_at', params: { step: 'Read', stepId: 's1' }, text: 'Stopped at "Read": no access' } }],
            nextCursor: 'next',
        };
    });
    swap(automationStore, 'getRunFacetsForAutomation', async (_id, filters) => {
        seen.facetFilters.push(filters);
        return { status: { success: 3, error: 1, awaiting_approval: 1, running: 1 } };
    });
    swap(automationStore, 'getJourneyStepStatuses', async () => new Map([['r1', [{ stepId: 's1', status: 'error', attempts: 1 }]]]));
    swap(automationStore, 'getVersionDefinitions', async () => new Map());
    swap(automationStore, 'getPendingApprovalIdsForRuns', async () => new Map());
    swap(automationStore, 'getRun', async (id) => (RUNS[id] ? { ...RUNS[id] } : null));
    swap(automationStore, 'getLatestRunInChain', async (id) => (id === 'waiting' ? { id: 'waiting-leg', status: 'awaiting_form' } : null));
    swap(automationStore, 'getRunSteps', async () => []);
    swap(userStore, 'getUser', async (id) => ({ id, organizationId: 'org1', groups: [] }));
    swap(userStore, 'getUserAvatarsByIds', async (ids) => ids.map(id => ({ id, displayName: id === 'owner' ? 'Olga' : id })));
    swap(permissions, 'hasPermission', async () => false);
    swap(runner, 'executeAutomation', async (a, opts) => {
        seen.executed.push(opts);
        const created = { id: 'new-run' };
        if (opts.onRunCreated) await opts.onRunCreated(created);
        return { id: 'new-run', status: 'success' };
    });

    api = serve('/', [require('./runs'), require('./webhooksAndRunOps')]);
});

after(async () => {
    restore();
    await api.close();
});

const call = (method, path, { as = 'owner', body } = {}) => api.call(method, path, { body, user: { id: as } });

test('GET /:id/runs: filters reach the store, rows are decorated, counts ride on the first page', async () => {
    seen.listFilters.length = 0;
    seen.facetFilters.length = 0;
    const res = await call('GET', '/a1/runs?status=error&q=invoice&startedBy=me&tests=exclude&since=2026-09-21T00:00:00.000Z');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(seen.listFilters[0], {
        status: ['error'], sinceTs: '2026-09-21T00:00:00.000Z', q: 'invoice', startedBy: 'owner', tests: 'exclude',
        cursor: undefined, limit: undefined,
    });
    // The counts ignore the status being chosen, and nothing else.
    assert.deepStrictEqual(seen.facetFilters[0], { sinceTs: '2026-09-21T00:00:00.000Z', q: 'invoice', startedBy: 'owner', tests: 'exclude' });
    assert.deepStrictEqual(res.body.facets, {
        all: 6, failed: 1, waiting: 1, running: 1,
        byStatus: { success: 3, error: 1, awaiting_approval: 1, running: 1 },
    });
    const row = res.body.runs[0];
    assert.deepStrictEqual(row.startedBy, { id: 'owner', name: 'Olga' });
    assert.strictEqual(row.howStarted, 'manual');
    assert.strictEqual(row.isTest, false);
    assert.strictEqual(row.version, 3);
    assert.strictEqual(row.stepsTotal, 2, 'the routine\'s definition stands in for a missing snapshot');
    assert.deepStrictEqual(row.stepStatuses, ['error', 'pending']);
    assert.strictEqual(row.outcome.code, 'stopped_at');

    const page2 = await call('GET', '/a1/runs?cursor=next');
    assert.strictEqual(page2.body.facets, undefined, 'a later page carries no counts');
});

test('GET /:id/runs: a bad tests value or an over-long q is a 400', async () => {
    assert.strictEqual((await call('GET', '/a1/runs?tests=maybe')).status, 400);
    assert.strictEqual((await call('GET', `/a1/runs?q=${'x'.repeat(101)}`)).status, 400);
});

test('GET /_runs/org: startedBy is refused (the org log carries no identity)', async () => {
    const undo = swap(permissions, 'hasPermission', async () => true);
    try {
        const res = await call('GET', '/_runs/org?startedBy=someone');
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'filter_not_available');
    } finally {
        undo();
    }
});

test('retry: a finished run runs again with the same input and entry trigger, and answers the new id', async () => {
    seen.executed.length = 0;
    const res = await call('POST', '/a1/runs/done/retry');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.runId, 'new-run');
    const opts = seen.executed[0];
    assert.strictEqual(opts.triggerKind, 'webhook');
    assert.deepStrictEqual(opts.triggerPayload, { a: 1 });
    assert.strictEqual(opts.rootStepId, 't2');
    assert.strictEqual(opts.parentRunId, 'done');
    assert.strictEqual(opts.mode, 'live');
    assert.strictEqual(opts.startedByUserId, 'owner');
});

test('retry: a preview is run again as a preview', async () => {
    seen.executed.length = 0;
    const res = await call('POST', '/a1/runs/preview/retry');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen.executed[0].mode, 'dry_run');
    assert.strictEqual(seen.executed[0].isTest, true);
});

test('retry: a journey still waiting on someone is refused with 409 run_not_finished', async () => {
    seen.executed.length = 0;
    const res = await call('POST', '/a1/runs/waiting/retry');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'run_not_finished');
    assert.deepStrictEqual(res.body.details, { status: 'awaiting_form' });
    assert.strictEqual(seen.executed.length, 0);
});
