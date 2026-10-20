/**
 * routes/automation/testCases.js — test cases on a code step or a custom node,
 * over a real Express app, the real test-data store on PGlite and the real
 * run-data door; the automation store, access table and sandbox are fakes.
 *
 * Proven:
 *   - view reads, cannot create, change, delete or run; edit can;
 *   - a custom node (kind 'block') needs its owner for writes and runs;
 *   - a typed case and a case captured from a run; the capture keeps only the
 *     declared inputs and the answer never carries fixture values;
 *   - capture from another automation's run is a 404, from a run on the
 *     starter's own connections or an unfinished run a 409, on a PRD stage a 409;
 *   - the per-step limit, the strict bodies, the assertion rules;
 *   - running: pass / fail / error / unusable, the unsaved code, the verdict kept.
 *
 * Run: cd server && node --test routes/automation/testCases.test.js
 */

'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { serve } = require('../../testUtils/routeHarness');
const { makeAutomationTestingStore, DDL } = require('../../stores/automationTestingStore');
const { makeRunDataAccess } = require('../../automation/testing/runDataAccess');
const { roleSatisfies } = require('../../automation/access');
const { accessByRole } = require('./testing/accessByRole');
const { makeTestCasesRouter } = require('./testCases');

const ROLES = { owner: 'owner', ed: 'edit', vic: 'view' };
const SECRET = 'fixture-secret-7731';

const code = (id) => ({ id, type: 'code', code: 'return { n: inputs.n * 2 };', inputs: { n: {}, secretKeys: ['k'] }, allowedTools: [] });
const def = () => ({ trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [code('s1'), { id: 'note', type: 'note' }, { id: 'lp', type: 'loop', body: [code('inner')] }] });

const AUTOMATIONS = {
    a1: { id: 'a1', userId: 'owner', kind: 'automation', organizationId: 'org1', projectId: null, definition: def() },
    a2: { id: 'a2', userId: 'owner', kind: 'automation', organizationId: 'org1', projectId: null, definition: def() },
    blk: { id: 'blk', userId: 'owner', kind: 'block', organizationId: 'org1', projectId: null, definition: def() },
    prd: { id: 'prd', userId: 'owner', kind: 'automation', organizationId: 'org1', projectId: 'prd-project', definition: def() },
};
const RUNS = {
    r1: { id: 'r1', automationId: 'a1', userId: 'owner', status: 'success' },
    rb: { id: 'rb', automationId: 'blk', userId: 'owner', status: 'success' },
    rp: { id: 'rp', automationId: 'prd', userId: 'owner', status: 'success' },
    r2: { id: 'r2', automationId: 'a2', userId: 'owner', status: 'success' },
    rcaller: { id: 'rcaller', automationId: 'a1', userId: 'owner', status: 'success', connectionsMode: 'caller', startedByUserId: 'ed' },
    rrun: { id: 'rrun', automationId: 'a1', userId: 'owner', status: 'running' },
};
const STEPS = [
    { runId: 'r1', stepId: 's1', attempts: 1, input: { n: 3, secretKeys: ['k'], stale: SECRET } },
    { runId: 'rb', stepId: 's1', attempts: 1, input: { n: 4 } },
    { runId: 'rp', stepId: 's1', attempts: 1, input: { n: 5 } },
    { runId: 'r2', stepId: 's1', attempts: 1, input: { n: 6 } },
    { runId: 'rcaller', stepId: 's1', attempts: 1, input: { n: 7 } },
    { runId: 'rrun', stepId: 's1', attempts: 1, input: { n: 8 } },
];

const fakeStore = {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    getRun: async (id) => RUNS[id] || null,
    getRunsInChain: async (id) => [RUNS[id]],
    getLatestRunInChain: async (id) => RUNS[id],
    getRunStepsForChain: async (id) => STEPS.filter((s) => s.runId === id),
};

const base = accessByRole(ROLES);
const access = {
    guard: base.guard,
    roleFor: async (_a, userId) => ({ role: ROLES[userId] || null }),
    runGuard: async (req, res, run, need) => {
        const role = ROLES[req.session.user.id];
        if (roleSatisfies(role, need === 'read' ? 'view' : 'edit')) return { role };
        res.status(403).json({ error: 'Forbidden' });
        return null;
    },
};

const sandboxCalls = [];
const sandbox = {
    isAvailable: () => true,
    async runCode(args) {
        sandboxCalls.push(args);
        if (args.inputs.boom) throw new Error('exploded');
        return { result: { n: (args.inputs.n || 0) * 2 }, logs: [], calls: [] };
    },
};

const { pg, db } = pgliteDb();
const testingStore = makeAutomationTestingStore(db);
let api;

before(async () => {
    await pg.exec('CREATE TABLE automations (id TEXT PRIMARY KEY); CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE);');
    await pg.exec(DDL);
    for (const id of Object.keys(AUTOMATIONS)) await pg.query('INSERT INTO automations (id) VALUES ($1)', [id]);
    for (const r of Object.values(RUNS)) await pg.query('INSERT INTO automation_runs (id, automation_id) VALUES ($1, $2)', [r.id, r.automationId]);
    const runDataAccess = makeRunDataAccess({
        store: fakeStore,
        access,
        managedInfo: async (projectId) => (projectId === 'prd-project' ? { stage: 'prd' } : null),
    });
    api = serve('/', makeTestCasesRouter({
        store: fakeStore, testingStore, access, sandbox, runDataAccess, limiter: (_req, _res, next) => next(),
    }));
});
after(async () => { await api.close(); await pg.close(); });

beforeEach(async () => {
    sandboxCalls.length = 0;
    await pg.exec('DELETE FROM automation_test_cases; DELETE FROM automation_test_fixtures;');
});
afterEach(() => { delete process.env.AUTOMATION_TEST_CASES_PER_STEP_MAX; });

const call = (user, method, path, body) => api.call(method, path, { body, user: { id: user, organizationId: 'org1' } });
const typed = (name = 'doubles', extra = {}) => ({ stepId: 's1', name, input: { kind: 'typed', values: { n: 2 } }, ...extra });
const create = async (user, automationId, body) => call(user, 'POST', `/${automationId}/test-cases`, body);

test('view can list and read, but not create, change, delete or run', async () => {
    const made = await create('ed', 'a1', typed());
    assert.strictEqual(made.status, 201);
    const id = made.body.testCase.id;
    const list = await call('vic', 'GET', '/a1/test-cases');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.testCases.length, 1);
    assert.deepStrictEqual(list.body.limits, { perStep: 50, assertions: 50 });
    assert.strictEqual((await call('vic', 'GET', `/a1/test-cases/${id}`)).status, 200);
    assert.strictEqual((await create('vic', 'a1', typed('x'))).status, 403);
    assert.strictEqual((await call('vic', 'PUT', `/a1/test-cases/${id}`, { name: 'y' })).status, 403);
    assert.strictEqual((await call('vic', 'DELETE', `/a1/test-cases/${id}`)).status, 403);
    assert.strictEqual((await call('vic', 'POST', '/a1/test-cases/run', { stepId: 's1' })).status, 403);
    assert.strictEqual((await call('stranger', 'GET', '/a1/test-cases')).status, 403);
    assert.strictEqual((await call('ed', 'GET', '/nope/test-cases')).status, 404);
});

test('edit creates a typed case; the list can be narrowed to one step', async () => {
    const made = await create('ed', 'a1', typed('one', { expect: 'success', assertions: [{ id: 'x', op: 'equals', path: 'n', value: 4 }] }));
    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.testCase.createdBy, 'ed');
    assert.deepStrictEqual(made.body.testCase.input, { kind: 'typed', values: { n: 2 } });
    assert.strictEqual((await create('ed', 'a1', { ...typed('inner one'), stepId: 'inner' })).status, 201, 'a step inside a loop body');
    assert.strictEqual((await call('ed', 'GET', '/a1/test-cases?stepId=inner')).body.testCases.length, 1);
    assert.strictEqual((await call('ed', 'GET', '/a1/test-cases')).body.testCases.length, 2);
});

test('only a code step can carry cases: a note or a missing step is a 404', async () => {
    for (const stepId of ['note', 'lp', 'gone']) {
        const r = await create('ed', 'a1', typed('x', { stepId }));
        assert.strictEqual(r.status, 404, stepId);
        assert.strictEqual(r.body.code, 'step_not_found');
    }
});

test('a custom node needs its owner to write and run, but anybody with view reads', async () => {
    assert.strictEqual((await create('ed', 'blk', typed())).status, 403);
    assert.strictEqual((await call('ed', 'POST', '/blk/test-cases/run', { stepId: 's1' })).status, 403);
    const made = await create('owner', 'blk', typed());
    assert.strictEqual(made.status, 201);
    assert.strictEqual((await call('ed', 'GET', '/blk/test-cases')).status, 200);
    assert.strictEqual((await call('ed', 'PUT', `/blk/test-cases/${made.body.testCase.id}`, { name: 'z' })).status, 403);
    assert.strictEqual((await call('ed', 'DELETE', `/blk/test-cases/${made.body.testCase.id}`)).status, 403);
    assert.strictEqual((await call('owner', 'POST', '/blk/test-cases/run', { stepId: 's1' })).status, 200);
    assert.strictEqual((await create('owner', 'blk', { stepId: 's1', name: 'from run', input: { kind: 'run', runId: 'rb' } })).status, 201);
});

test('a case from a run keeps only the declared inputs and never shows them in a row', async () => {
    const made = await create('ed', 'a1', { stepId: 's1', name: 'from run', input: { kind: 'run', runId: 'r1' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.testCase.input.kind, 'run');
    assert.strictEqual(made.body.testCase.input.runId, 'r1');
    assert.strictEqual(made.body.testCase.input.available, true);
    assert.ok(!JSON.stringify(made.body).includes(SECRET));
    assert.ok(!JSON.stringify((await call('ed', 'GET', '/a1/test-cases')).body).includes('"n":3'), 'the list has no fixture values');

    const detail = await call('vic', 'GET', `/a1/test-cases/${made.body.testCase.id}`);
    assert.deepStrictEqual(detail.body.input, { kind: 'run', available: true, values: { n: 3 }, runId: 'r1' });
    assert.ok(!JSON.stringify(detail.body).includes(SECRET), 'the stale and secret keys were never kept');
});

test('capture is refused for another automation\'s run (404), a caller-mode run, an unfinished run (409), an unknown run', async () => {
    const attempt = (runId) => create('ed', 'a1', { stepId: 's1', name: 'x', input: { kind: 'run', runId } });
    const other = await attempt('r2');
    assert.strictEqual(other.status, 404);
    assert.strictEqual(other.body.code, 'run_not_found');
    const caller = await attempt('rcaller');
    assert.strictEqual(caller.status, 409);
    assert.strictEqual(caller.body.code, 'caller_run_not_capturable');
    const running = await attempt('rrun');
    assert.strictEqual(running.status, 409);
    assert.strictEqual(running.body.code, 'run_not_finished');
    assert.strictEqual((await attempt('missing')).status, 404);
    assert.strictEqual((await call('ed', 'GET', '/a1/test-cases')).body.testCases.length, 0, 'nothing half-made');
    assert.strictEqual(Number((await pg.query('SELECT COUNT(*)::int AS n FROM automation_test_fixtures')).rows[0].n), 0);
});

test('a step with no recorded input in that run is a 422', async () => {
    const r = await create('ed', 'a1', { stepId: 'inner', name: 'x', input: { kind: 'run', runId: 'r1' } });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'step_not_in_run');
});

test('an automation in a PRD stage keeps no test data', async () => {
    const typedCase = await create('owner', 'prd', typed());
    assert.strictEqual(typedCase.status, 409);
    assert.strictEqual(typedCase.body.code, 'test_data_not_on_prd');
    const fromRun = await create('owner', 'prd', { stepId: 's1', name: 'x', input: { kind: 'run', runId: 'rp' } });
    assert.strictEqual(fromRun.body.code, 'test_data_not_on_prd');
});

test('the per-step limit is a 409 and 0 means unlimited', async () => {
    process.env.AUTOMATION_TEST_CASES_PER_STEP_MAX = '2';
    assert.strictEqual((await create('ed', 'a1', typed('1'))).status, 201);
    assert.strictEqual((await create('ed', 'a1', typed('2'))).status, 201);
    const third = await create('ed', 'a1', typed('3'));
    assert.strictEqual(third.status, 409);
    assert.strictEqual(third.body.code, 'test_case_limit');
    assert.strictEqual((await create('ed', 'a1', { ...typed('3'), stepId: 'inner' })).status, 201, 'the limit is per step');
    process.env.AUTOMATION_TEST_CASES_PER_STEP_MAX = '0';
    assert.strictEqual((await create('ed', 'a1', typed('4'))).status, 201);
});

test('bodies are strict and assertions are checked', async () => {
    assert.strictEqual((await create('ed', 'a1', { ...typed(), extra: 1 })).status, 400);
    assert.strictEqual((await create('ed', 'a1', { stepId: 's1', name: 'x', input: { kind: 'typed', values: {}, more: 1 } })).status, 400);
    assert.strictEqual((await create('ed', 'a1', { stepId: 's1', name: '   ', input: { kind: 'typed', values: {} } })).status, 400);
    assert.strictEqual((await create('ed', 'a1', { stepId: 's1', name: 'x'.repeat(81), input: { kind: 'typed', values: {} } })).status, 400);
    assert.strictEqual((await create('ed', 'a1', { stepId: 's1', name: 'x' })).status, 400);
    assert.strictEqual((await create('ed', 'a1', { ...typed(), expect: 'maybe' })).status, 400);
    const bad = await create('ed', 'a1', typed('x', { assertions: [{ id: 'a', op: 'eval', value: 1 }] }));
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error || bad.body.message || JSON.stringify(bad.body), /op must be/);
    assert.strictEqual((await create('ed', 'a1', typed('x', { assertions: [{ id: 'a', op: 'equals', value: 1, code: 'x' }] }))).status, 400);
    assert.strictEqual((await call('ed', 'POST', '/a1/test-cases/run', { stepId: 's1', caseIds: Array.from({ length: 51 }, (_, i) => `c${i}`) })).status, 400);
    assert.strictEqual((await call('ed', 'POST', '/a1/test-cases/run', { stepId: 's1', other: 1 })).status, 400);
    assert.strictEqual((await call('ed', 'GET', '/a1/test-cases?bogus=1')).status, 400);
    assert.strictEqual((await call('ed', 'PUT', '/a1/test-cases/tc_x', { surprise: true })).status, 400);
});

test('update: rename, change expectation and assertions, switch the input; a run input re-captures', async () => {
    const made = (await create('ed', 'a1', typed())).body.testCase;
    const renamed = await call('ed', 'PUT', `/a1/test-cases/${made.id}`, { name: 'renamed', expect: 'error', assertions: [{ id: 'm', op: 'contains', path: 'message', value: 'x' }] });
    assert.strictEqual(renamed.status, 200);
    assert.strictEqual(renamed.body.testCase.name, 'renamed');
    assert.strictEqual(renamed.body.testCase.expect, 'error');
    const recaptured = await call('ed', 'PUT', `/a1/test-cases/${made.id}`, { input: { kind: 'run', runId: 'r1' } });
    assert.strictEqual(recaptured.status, 200);
    assert.strictEqual(recaptured.body.testCase.input.kind, 'run');
    const firstFixture = recaptured.body.testCase.input.fixtureId;
    const again = await call('ed', 'PUT', `/a1/test-cases/${made.id}`, { input: { kind: 'run', runId: 'r1' } });
    assert.notStrictEqual(again.body.testCase.input.fixtureId, firstFixture);
    assert.strictEqual(Number((await pg.query('SELECT COUNT(*)::int AS n FROM automation_test_fixtures')).rows[0].n), 1, 'the replaced fixture is gone');
    const back = await call('ed', 'PUT', `/a1/test-cases/${made.id}`, { input: { kind: 'typed', values: { n: 9 } } });
    assert.deepStrictEqual(back.body.testCase.input, { kind: 'typed', values: { n: 9 } });
    assert.strictEqual((await call('ed', 'PUT', '/a1/test-cases/tc_none', { name: 'x' })).status, 404);
    assert.strictEqual((await call('ed', 'PUT', `/a2/test-cases/${made.id}`, { name: 'x' })).status, 404, 'a case is only reachable through its own automation');
    const refused = await call('ed', 'PUT', `/a1/test-cases/${made.id}`, { input: { kind: 'run', runId: 'rcaller' } });
    assert.strictEqual(refused.status, 409);
});

test('delete removes the case and its fixture', async () => {
    const made = (await create('ed', 'a1', { stepId: 's1', name: 'x', input: { kind: 'run', runId: 'r1' } })).body.testCase;
    assert.deepStrictEqual((await call('ed', 'DELETE', `/a1/test-cases/${made.id}`)).body, { deleted: true });
    assert.strictEqual((await call('ed', 'DELETE', `/a1/test-cases/${made.id}`)).status, 404);
    assert.strictEqual(Number((await pg.query('SELECT COUNT(*)::int AS n FROM automation_test_fixtures')).rows[0].n), 0);
});

test('run: pass, fail, error and unusable, the unsaved code, and the verdict is kept', async () => {
    const ok = (await create('ed', 'a1', typed('ok', { assertions: [{ id: 'x', op: 'equals', path: 'n', value: 4 }] }))).body.testCase;
    const wrong = (await create('ed', 'a1', typed('wrong', { assertions: [{ id: 'x', op: 'equals', path: 'n', value: 5 }] }))).body.testCase;
    const thrown = (await create('ed', 'a1', { stepId: 's1', name: 'thrown', input: { kind: 'typed', values: { boom: 1 } } })).body.testCase;
    const expired = (await create('ed', 'a1', { stepId: 's1', name: 'expired', input: { kind: 'run', runId: 'r1' } })).body.testCase;
    await pg.query('DELETE FROM automation_test_fixtures');

    const r = await call('ed', 'POST', '/a1/test-cases/run', { stepId: 's1' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const byId = Object.fromEntries(r.body.results.map((x) => [x.caseId, x]));
    assert.strictEqual(byId[ok.id].status, 'pass');
    assert.strictEqual(byId[wrong.id].status, 'fail');
    assert.strictEqual(byId[wrong.id].assertions[0].code, 'not_equal');
    assert.strictEqual(byId[thrown.id].status, 'fail');
    assert.strictEqual(byId[thrown.id].expectation.got, 'error');
    assert.strictEqual(byId[expired.id].status, 'unusable');
    assert.strictEqual(byId[expired.id].reason, 'fixture_expired');
    assert.deepStrictEqual(r.body.summary, { passed: 1, failed: 2, errored: 0, unusable: 1 });
    assert.strictEqual(r.body.stepId, 's1');
    assert.strictEqual((await call('vic', 'GET', `/a1/test-cases/${ok.id}`)).body.testCase.lastStatus, 'pass');
    assert.strictEqual(sandboxCalls[0].mode, 'test');

    const only = await call('ed', 'POST', '/a1/test-cases/run', { stepId: 's1', caseIds: [ok.id], code: 'return { n: 4 };' });
    assert.strictEqual(only.body.results.length, 1);
    assert.strictEqual(sandboxCalls.at(-1).code, 'return { n: 4 };');
    assert.strictEqual((await call('ed', 'POST', '/a1/test-cases/run', { stepId: 's1', caseIds: ['tc_none'] })).status, 404);
    assert.strictEqual((await call('ed', 'POST', '/a1/test-cases/run', { stepId: 'note' })).status, 404);
    const syntax = await call('ed', 'POST', '/a1/test-cases/run', { stepId: 's1', caseIds: [ok.id], code: 'return {;' });
    assert.deepStrictEqual([syntax.body.results[0].status, syntax.body.results[0].reason], ['error', 'code_syntax_error']);
    assert.strictEqual(syntax.body.summary.errored, 1);
});

test('run on a step with no cases answers an empty summary', async () => {
    const r = await call('ed', 'POST', '/a1/test-cases/run', { stepId: 'inner' });
    assert.deepStrictEqual(r.body, { stepId: 'inner', results: [], summary: { passed: 0, failed: 0, errored: 0, unusable: 0 } });
});
