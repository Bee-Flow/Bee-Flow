/**
 * GET /runs/:runId/compare/:otherRunId, with a fake run-data door and comparer.
 * Run: cd server && node --test routes/automation/runCompare.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { serve } = require('../../testUtils/routeHarness');
const { HttpError } = require('../../core/http/errors');
const { makeRunDataAccess } = require('../../automation/testing/runDataAccess');
const { makeRunCompareRouter } = require('./runCompare');

const USERS = {
    owner: { id: 'owner', organizationId: 'org1' },
    outsider: { id: 'outsider', organizationId: 'org2' },
};
const RUNS = {
    r1: { id: 'r1', automationId: 'a1', userId: 'owner' },
    r2: { id: 'r2', automationId: 'a1', userId: 'owner' },
    r3: { id: 'r3', automationId: 'a2', userId: 'owner' },
};

let seen;
let compared;
const fakeDoor = {
    async readableRun(req, res, runId) {
        seen.push(runId);
        const run = RUNS[runId];
        if (!run) throw new HttpError(404, 'run_not_found', 'Not found');
        if (runId === 'rDenied') { res.status(403).json({ error: 'Forbidden' }); return null; }
        return { run, root: run, legs: [run], runIds: [run.id] };
    },
};
const RESULT = { a: { runId: 'r1' }, b: { runId: 'r2' }, verdict: 'same', summary: {}, steps: [], truncated: false };

let api;
before(() => {
    api = serve('/', makeRunCompareRouter({
        runDataAccess: fakeDoor,
        compareRuns: async (input, deps) => { compared.push({ input, deps }); return RESULT; },
    }));
});
after(async () => { await api.close(); });
beforeEach(() => { seen = []; compared = []; });

const get = (path, as = 'owner') => api.call('GET', path, { user: USERS[as] });

test('two runs of one automation are compared; both go through the run door', async () => {
    const res = await get('/runs/r1/compare/r2');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, RESULT);
    assert.deepStrictEqual(seen, ['r1', 'r2']);
    assert.match(res.headers.get('cache-control'), /private/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const { input } = compared[0];
    assert.strictEqual(input.runA.id, 'r1');
    assert.strictEqual(input.runB.id, 'r2');
    assert.strictEqual(input.viewerId, 'owner');
    assert.strictEqual(input.stepId, null);
    assert.deepStrictEqual(input.legsA.map(l => l.id), ['r1']);
});

test('stepId narrows the comparison', async () => {
    await get('/runs/r1/compare/r2?stepId=s1');
    assert.strictEqual(compared[0].input.stepId, 's1');
});

test('runs of different automations are not comparable (400)', async () => {
    const res = await get('/runs/r1/compare/r3');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'runs_not_comparable');
    assert.deepStrictEqual(compared, []);
});

test('a missing run is a 404; a refused run answers its own 403 and nothing is compared', async () => {
    assert.strictEqual((await get('/runs/nope/compare/r2')).status, 404);
    assert.strictEqual((await get('/runs/r1/compare/nope')).status, 404);
    RUNS.rDenied = { id: 'rDenied', automationId: 'a1', userId: 'owner' };
    try {
        assert.strictEqual((await get('/runs/r1/compare/rDenied')).status, 403);
        assert.strictEqual((await get('/runs/rDenied/compare/r1')).status, 403);
    } finally { delete RUNS.rDenied; }
    assert.deepStrictEqual(compared, []);
});

test('a too-long stepId and an unknown query key are refused before any run is read', async () => {
    const long = await get(`/runs/r1/compare/r2?stepId=${'x'.repeat(201)}`);
    assert.strictEqual(long.status, 400);
    const unknown = await get('/runs/r1/compare/r2?other=1');
    assert.strictEqual(unknown.status, 400);
    assert.deepStrictEqual(seen, []);
});

test('with the real run door, a caller with no role on the automation gets a 404 for either run', async () => {
    const store = {
        getRun: async (id) => RUNS[id] || null,
        getAutomation: async (id) => ({ id, userId: 'owner', organizationId: 'org1' }),
        getRunsInChain: async (id) => [RUNS[id]],
    };
    const access = {
        roleFor: async (_a, userId) => ({ role: userId === 'owner' ? 'owner' : null }),
        runGuard: async () => ({ role: 'owner' }),
    };
    const real = serve('/', makeRunCompareRouter({
        runDataAccess: makeRunDataAccess({ store, access }),
        compareRuns: async (input) => { compared.push({ input }); return RESULT; },
    }));
    try {
        const ok = await real.call('GET', '/runs/r1/compare/r2', { user: USERS.owner });
        assert.strictEqual(ok.status, 200);
        const denied = await real.call('GET', '/runs/r1/compare/r2', { user: USERS.outsider });
        assert.strictEqual(denied.status, 404);
        assert.strictEqual(denied.body.code, 'run_not_found');
    } finally { await real.close(); }
});

test('comparisons are limited per user by AUTOMATION_RUN_COMPARE_RPM, and 0 lifts the limit', async () => {
    const saved = process.env.AUTOMATION_RUN_COMPARE_RPM;
    const build = () => serve('/', makeRunCompareRouter({ runDataAccess: fakeDoor, compareRuns: async () => RESULT }));
    try {
        process.env.AUTOMATION_RUN_COMPARE_RPM = '2';
        const limited = build();
        try {
            const call = (as) => limited.call('GET', '/runs/r1/compare/r2', { user: USERS[as] });
            assert.strictEqual((await call('owner')).status, 200);
            assert.strictEqual((await call('owner')).status, 200);
            assert.strictEqual((await call('owner')).status, 429);
        } finally { await limited.close(); }

        process.env.AUTOMATION_RUN_COMPARE_RPM = '0';
        const open = build();
        try {
            for (let i = 0; i < 5; i++) assert.strictEqual((await open.call('GET', '/runs/r1/compare/r2', { user: USERS.owner })).status, 200);
        } finally { await open.close(); }
    } finally {
        if (saved === undefined) delete process.env.AUTOMATION_RUN_COMPARE_RPM; else process.env.AUTOMATION_RUN_COMPARE_RPM = saved;
    }
});
