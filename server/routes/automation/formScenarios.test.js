/**
 * Form scenarios: save the answers of a real run, list them, rename, delete
 * and dry-run an automation with them. The router takes its stores, access
 * and runner injected; the run-data door (automation/testing/runDataAccess.js)
 * is the real one over the same fakes.
 *
 * The cast: ed (edit), vic (view), out (no role). Synthetic data only.
 *
 * Run: cd server && node --test routes/automation/formScenarios.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const { serve } = require('../../testUtils/routeHarness');
const { HttpError } = require('../../core/http/errors');
const { accessByRole } = require('./testing/accessByRole');
const { makeRunDataAccess } = require('../../automation/testing/runDataAccess');
const { makeFormScenariosRouter } = require('./formScenarios');

const USERS = {
    ed: { id: 'ed', organizationId: 'org1' },
    vic: { id: 'vic', organizationId: 'org1' },
    out: { id: 'out', organizationId: 'org1' },
};
const SECRET = 'SYNTHETIC-ANSWER-4711';

const DEFINITION = {
    trigger: { id: 'trg', kind: 'form', form: { fields: [{ name: 'topic', type: 'text', label: 'Topic' }] } },
    steps: [{ id: 'fp1', type: 'form_page', mode: 'input', form: { fields: [{ name: 'note', type: 'text', label: 'Note' }] } }],
};

let AUTOMATIONS;
let RUNS;
let STEPS;
let SCENARIOS;
let STAGE;
let seq;
const executed = [];

const fakeStore = {
    getAutomation: async (id) => (AUTOMATIONS[id] ? { ...AUTOMATIONS[id] } : null),
    getRun: async (id) => (RUNS[id] ? { ...RUNS[id] } : null),
    getRunsInChain: async (id) => [{ ...RUNS[id] }],
    getLatestRunInChain: async (id) => ({ ...RUNS[id] }),
    getVersionDefinition: async () => DEFINITION,
    getRunStepsForChain: async (id) => (STEPS[id] || []).map((s) => ({ ...s })),
    getRunSteps: async () => [{ stepId: 'fp1', status: 'success' }],
};

const fakeTesting = {
    async listFormScenarios(automationId) { return SCENARIOS.filter((s) => s.automationId === automationId).map(({ answers, ...row }) => row); },
    async getFormScenario(automationId, id) { return SCENARIOS.find((s) => s.automationId === automationId && s.id === id) || null; },
    async countFormScenarios(automationId) { return SCENARIOS.filter((s) => s.automationId === automationId).length; },
    async createFormScenario({ automationId, sourceRunId, name, answers, createdBy }) {
        if (SCENARIOS.some((s) => s.automationId === automationId && s.name === name)) throw new HttpError(409, 'scenario_name_taken', 'taken');
        const row = {
            id: `fsc_${++seq}`, automationId, sourceRunId, name, createdBy, createdAt: '2026-10-01T10:00:00.000Z', answers,
            hasTriggerAnswers: !!answers.trigger && Object.keys(answers.trigger).length > 0,
            pages: Object.entries(answers.pages).map(([stepId, v]) => ({ stepId, fieldCount: Object.keys(v).length })),
            skipped: answers.skipped,
        };
        SCENARIOS.push(row);
        return row;
    },
    async renameFormScenario(automationId, id, name) {
        const row = SCENARIOS.find((s) => s.automationId === automationId && s.id === id);
        if (!row) return null;
        row.name = name;
        return row;
    },
    async deleteFormScenario(automationId, id) {
        const i = SCENARIOS.findIndex((s) => s.automationId === automationId && s.id === id);
        if (i < 0) return false;
        SCENARIOS.splice(i, 1);
        return true;
    },
};

const roleOf = { ed: 'edit', vic: 'view' };
const fakeAccess = accessByRole(roleOf);
const runDataAccess = makeRunDataAccess({
    store: fakeStore,
    access: {
        roleFor: async (_a, me) => ({ role: roleOf[me] || null }),
        runGuard: async () => true,
    },
    managedInfo: async () => (STAGE ? { stage: STAGE } : null),
});

let api;
before(() => {
    api = serve('/', makeFormScenariosRouter({
        store: fakeStore,
        testingStore: fakeTesting,
        access: fakeAccess,
        runDataAccess,
        limiter: (_req, _res, next) => next(),
        executeAutomation: async (a, opts) => { executed.push({ id: a.id, ...opts }); return { id: 'dry-1', status: 'success' }; },
    }));
});
after(async () => { await api.close(); });

beforeEach(() => {
    seq = 0;
    STAGE = null;
    executed.length = 0;
    SCENARIOS = [];
    AUTOMATIONS = {
        a1: { id: 'a1', userId: 'ed', organizationId: 'org1', definition: DEFINITION },
        a2: { id: 'a2', userId: 'ed', organizationId: 'org1', definition: DEFINITION },
    };
    RUNS = {
        r1: { id: 'r1', automationId: 'a1', userId: 'ed', version: 2, status: 'success', rootRunId: 'r1', triggerPayload: { topic: SECRET } },
        rOther: { id: 'rOther', automationId: 'a2', userId: 'ed', version: 1, status: 'success', rootRunId: 'rOther' },
        rCaller: { id: 'rCaller', automationId: 'a1', userId: 'ed', startedByUserId: 'ed', connectionsMode: 'caller', version: 1, status: 'success', triggerPayload: { topic: 'x' } },
        rEmpty: { id: 'rEmpty', automationId: 'a1', userId: 'ed', version: 1, status: 'success', triggerPayload: {} },
        rBusy: { id: 'rBusy', automationId: 'a1', userId: 'ed', version: 1, status: 'running', triggerPayload: { topic: 'x' } },
    };
    STEPS = {
        r1: [{ runId: 'r1', stepId: 'fp1', parentStepId: null, attempts: 1, status: 'success', output: { note: 'hello', _dryRun: false } }],
        rEmpty: [],
    };
});

const as = (who) => ({ user: USERS[who] });
const create = (who, body, id = 'a1') => api.call('POST', `/${id}/form-scenarios`, { ...as(who), body });

// ── create ───────────────────────────────────────────────────────────

test('an editor saves the answers of a run; the response carries no answer values', async () => {
    const res = await create('ed', { name: '  Happy path  ', fromRunId: 'r1' });
    assert.strictEqual(res.status, 201);
    const s = res.body.scenario;
    assert.strictEqual(s.name, 'Happy path');
    assert.strictEqual(s.hasTriggerAnswers, true);
    assert.deepStrictEqual(s.pages, [{ stepId: 'fp1', fieldCount: 1 }]);
    assert.strictEqual(s.sourceRunId, 'r1');
    assert.ok(!JSON.stringify(res.body).includes(SECRET));
    assert.deepStrictEqual(SCENARIOS[0].answers.pages, { fp1: { note: 'hello' } });
    assert.strictEqual(SCENARIOS[0].createdBy, 'ed');
});

test('a viewer lists and reads scenarios but cannot create, rename or delete', async () => {
    await create('ed', { name: 'one', fromRunId: 'r1' });
    const list = await api.call('GET', '/a1/form-scenarios', as('vic'));
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.scenarios.length, 1);
    assert.strictEqual(list.body.limits.max, 50);
    assert.ok(!JSON.stringify(list.body).includes(SECRET), 'the list carries no answers');

    const one = await api.call('GET', '/a1/form-scenarios/fsc_1', as('vic'));
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual(one.body.scenario.answers.pages, { fp1: { note: 'hello' } });
    assert.strictEqual(one.body.scenario.answers.trigger.topic, SECRET);

    assert.strictEqual((await create('vic', { name: 'two', fromRunId: 'r1' })).status, 403);
    assert.strictEqual((await api.call('PUT', '/a1/form-scenarios/fsc_1', { ...as('vic'), body: { name: 'x' } })).status, 403);
    assert.strictEqual((await api.call('DELETE', '/a1/form-scenarios/fsc_1', as('vic'))).status, 403);
    assert.strictEqual((await api.call('POST', '/a1/form-scenarios/fsc_1/dry-run', { ...as('vic'), body: {} })).status, 403);
    assert.strictEqual((await api.call('GET', '/a1/form-scenarios', as('out'))).status, 403);
});

test('a run of another automation is a 404', async () => {
    const res = await create('ed', { name: 'x', fromRunId: 'rOther' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'run_not_found');
    assert.strictEqual((await create('ed', { name: 'x', fromRunId: 'nope' })).status, 404);
});

test('a run on the starter\'s own connections cannot be captured', async () => {
    const res = await create('ed', { name: 'x', fromRunId: 'rCaller' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'caller_run_not_capturable');
});

test('an unfinished run cannot be captured', async () => {
    const res = await create('ed', { name: 'x', fromRunId: 'rBusy' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'run_not_finished');
});

test('a PRD stage keeps no test data', async () => {
    STAGE = 'prd';
    const res = await create('ed', { name: 'x', fromRunId: 'r1' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'test_data_not_on_prd');
    assert.deepStrictEqual(SCENARIOS, []);
});

test('a run without form answers is a 422 no_form_answers', async () => {
    const res = await create('ed', { name: 'x', fromRunId: 'rEmpty' });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'no_form_answers');
});

test('the answers over the size cap are a 413 scenario_too_large', async () => {
    process.env.AUTOMATION_FORM_SCENARIO_MAX_BYTES = '40';
    try {
        const res = await create('ed', { name: 'x', fromRunId: 'r1' });
        assert.strictEqual(res.status, 413);
        assert.strictEqual(res.body.code, 'scenario_too_large');
    } finally { delete process.env.AUTOMATION_FORM_SCENARIO_MAX_BYTES; }
});

test('the count cap is a 409 scenario_limit, and 0 means unlimited', async () => {
    process.env.AUTOMATION_FORM_SCENARIOS_MAX = '1';
    try {
        assert.strictEqual((await create('ed', { name: 'one', fromRunId: 'r1' })).status, 201);
        const res = await create('ed', { name: 'two', fromRunId: 'r1' });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.code, 'scenario_limit');
        process.env.AUTOMATION_FORM_SCENARIOS_MAX = '0';
        assert.strictEqual((await create('ed', { name: 'two', fromRunId: 'r1' })).status, 201);
    } finally { delete process.env.AUTOMATION_FORM_SCENARIOS_MAX; }
});

test('a taken name is a 409 scenario_name_taken', async () => {
    await create('ed', { name: 'same', fromRunId: 'r1' });
    const res = await create('ed', { name: 'same', fromRunId: 'r1' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'scenario_name_taken');
});

// ── rename, delete ───────────────────────────────────────────────────

test('rename and delete; an unknown scenario is a 404', async () => {
    await create('ed', { name: 'one', fromRunId: 'r1' });
    const renamed = await api.call('PUT', '/a1/form-scenarios/fsc_1', { ...as('ed'), body: { name: ' renamed ' } });
    assert.strictEqual(renamed.status, 200);
    assert.strictEqual(renamed.body.scenario.name, 'renamed');
    assert.strictEqual((await api.call('PUT', '/a1/form-scenarios/nope', { ...as('ed'), body: { name: 'x' } })).status, 404);
    assert.deepStrictEqual((await api.call('DELETE', '/a1/form-scenarios/fsc_1', as('ed'))).body, { deleted: true });
    assert.strictEqual((await api.call('DELETE', '/a1/form-scenarios/fsc_1', as('ed'))).status, 404);
    assert.strictEqual((await api.call('GET', '/a1/form-scenarios/fsc_1', as('ed'))).status, 404);
    assert.strictEqual((await api.call('GET', '/nope/form-scenarios', as('ed'))).status, 404);
});

// ── dry run ──────────────────────────────────────────────────────────

test('the dry run hands the answers to the runner as a harness and the trigger payload', async () => {
    await create('ed', { name: 'one', fromRunId: 'r1' });
    const res = await api.call('POST', '/a1/form-scenarios/fsc_1/dry-run', { ...as('ed'), body: {} });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.run.id, 'dry-1');
    assert.strictEqual(res.body.steps.length, 1);
    const call = executed[0];
    assert.strictEqual(call.mode, 'dry_run');
    assert.strictEqual(call.triggerKind, 'dry_run');
    assert.strictEqual(call.rootStepId, null);
    assert.strictEqual(call.startedByUserId, 'ed');
    assert.deepStrictEqual(call.triggerPayload, { topic: SECRET });
    assert.deepStrictEqual(call.harness, {
        source: { kind: 'scenario', id: 'fsc_1' },
        formAnswers: { pages: { fp1: { note: 'hello' } } },
        aiAnswers: 'live',
    });
});

test('the dry run follows a chosen trigger and refuses an unknown one with a 400', async () => {
    AUTOMATIONS.a1.definition = { ...DEFINITION, triggers: [{ id: 'trg2', kind: 'webhook' }] };
    await create('ed', { name: 'one', fromRunId: 'r1' });
    const ok = await api.call('POST', '/a1/form-scenarios/fsc_1/dry-run', { ...as('ed'), body: { triggerStepId: 'trg2' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(executed[0].rootStepId, 'trg2');
    const bad = await api.call('POST', '/a1/form-scenarios/fsc_1/dry-run', { ...as('ed'), body: { triggerStepId: 'zzz' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(executed.length, 1);
    assert.strictEqual((await api.call('POST', '/a1/form-scenarios/nope/dry-run', { ...as('ed'), body: {} })).status, 404);
});

// ── bodies are strict ────────────────────────────────────────────────

test('bodies are strict: unknown keys, bad names and missing fields are 400', async () => {
    assert.strictEqual((await create('ed', { name: 'x', fromRunId: 'r1', extra: 1 })).status, 400);
    assert.strictEqual((await create('ed', { name: '', fromRunId: 'r1' })).status, 400);
    assert.strictEqual((await create('ed', { name: 'x'.repeat(81), fromRunId: 'r1' })).status, 400);
    assert.strictEqual((await create('ed', { name: 'x' })).status, 400);
    assert.strictEqual((await create('ed', {})).status, 400);
    await create('ed', { name: 'one', fromRunId: 'r1' });
    assert.strictEqual((await api.call('PUT', '/a1/form-scenarios/fsc_1', { ...as('ed'), body: { name: 'x', extra: 1 } })).status, 400);
    assert.strictEqual((await api.call('POST', '/a1/form-scenarios/fsc_1/dry-run', { ...as('ed'), body: { answers: {} } })).status, 400);
    assert.strictEqual(SCENARIOS.length, 1);
    assert.deepStrictEqual(executed, []);
});
