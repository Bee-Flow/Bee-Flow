/**
 * Form scenarios over MCP: the same ownership scope as the run reads, no
 * answer values in the list, a dry run whose result is shapes only, and the
 * wiring in the MCP dispatcher. Synthetic data throughout.
 *
 * Run: cd server && node --test automation/mcpFormScenarios.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFormScenarioTools, FORM_SCENARIO_TOOLS, FORM_SCENARIO_TOOL_NAMES, guideSection } = require('./mcpFormScenarios');
const { configureStageVars } = require('../core/automationRunner/stageVars');

const OWNER = 'u_owner';
const ORG = 'org_a';
const SECRET = 'zz-scenario-secret-4711';

const SCENARIO = {
    id: 'fsc_1', automationId: 'auto_1', sourceRunId: 'run_9', name: 'Happy path', createdAt: '2026-10-01T10:00:00.000Z',
    hasTriggerAnswers: true,
    pages: [{ stepId: 'fp1', fieldCount: 2 }],
    skipped: [{ stepId: 'fp1', field: 'doc', reason: 'file' }],
    answers: { v: 1, trigger: { topic: SECRET }, pages: { fp1: { note: SECRET, count: 4 } }, skipped: [] },
};

function world({ automationOwner = OWNER, steps, allowRun } = {}) {
    const calls = { execute: [] };
    const automation = {
        id: 'auto_1', userId: automationOwner, organizationId: ORG,
        definition: { trigger: { id: 'trg', kind: 'manual' }, triggers: [{ id: 'trg2', kind: 'webhook' }], steps: [] },
    };
    const store = {
        getAutomation: async (id) => (id === 'auto_1' ? automation : null),
        getRunSteps: async () => steps || [
            {
                stepId: 'fp1', stepType: 'form_page', status: 'success', error: null, errorClass: null,
                startedAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T10:00:01.500Z',
                output: { note: SECRET, count: 4, _fromScenario: true },
            },
            {
                stepId: 'mail', stepType: 'gmail_compose', status: 'error', errorClass: 'tool_error',
                startedAt: '2026-10-01T10:00:02.000Z', finishedAt: '2026-10-01T10:00:02.100Z',
                error: `Could not send to "${SECRET}" at someone@example.test`,
                output: null,
            },
        ],
    };
    const testingStore = {
        listFormScenarios: async (id) => (id === 'auto_1' ? [SCENARIO].map(({ answers, ...row }) => row) : []),
        getFormScenario: async (id, sid) => (id === 'auto_1' && sid === 'fsc_1' ? SCENARIO : null),
    };
    const tools = makeFormScenarioTools({
        store,
        testingStore,
        getUser: async (id) => ({ id, organizationId: ORG }),
        ...(allowRun ? { allowRun } : {}),
        executeAutomation: async (a, opts) => { calls.execute.push({ id: a.id, ...opts }); return { id: 'dry_1', status: 'error' }; },
    });
    return { tools, calls };
}

test('the tools are described, read-only in intent, and the guide section explains scenarios', () => {
    assert.deepEqual([...FORM_SCENARIO_TOOL_NAMES], ['automations_list_form_scenarios', 'automations_dry_run_form_scenario']);
    assert.equal(FORM_SCENARIO_TOOLS.length, 2);
    const guide = guideSection();
    assert.match(guide, /^## Form scenarios \(dry run\)/);
    for (const name of FORM_SCENARIO_TOOL_NAMES) assert.ok(guide.includes(name), name);
    assert.match(guide, /in the product/);
    assert.match(guide, /shapes only/i);
});

test('an automation that is not the token user\'s own is a described 404 for both tools', async () => {
    const { tools, calls } = world({ automationOwner: 'someone_else' });
    for (const [name, args] of [
        ['automations_list_form_scenarios', { automationId: 'auto_1' }],
        ['automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'fsc_1' }],
        ['automations_list_form_scenarios', { automationId: 'auto_none' }],
    ]) {
        const out = await tools.call(name, args, { userId: OWNER });
        assert.equal(out.code, 'not_found', name);
    }
    assert.deepEqual(calls.execute, []);
});

test('the list carries counts and names, never an answer value', async () => {
    const { tools } = world();
    const out = await tools.call('automations_list_form_scenarios', { automationId: 'auto_1' }, { userId: OWNER });
    assert.deepEqual(out, {
        scenarios: [{
            scenarioId: 'fsc_1', name: 'Happy path', hasTriggerAnswers: true,
            pages: [{ stepId: 'fp1', fieldCount: 2 }], skippedCount: 1, createdAt: '2026-10-01T10:00:00.000Z',
        }],
    });
    assert.ok(!JSON.stringify(out).includes(SECRET));
});

test('the dry run plays the scenario and answers with shapes only', async () => {
    const { tools, calls } = world();
    const out = await tools.call('automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'fsc_1' }, { userId: OWNER });
    const call = calls.execute[0];
    assert.equal(call.mode, 'dry_run');
    assert.equal(call.startedByUserId, OWNER);
    assert.equal(call.rootStepId, null);
    assert.deepEqual(call.triggerPayload, { topic: SECRET });
    assert.deepEqual(call.harness.formAnswers, { pages: { fp1: { note: SECRET, count: 4 } } });
    assert.equal(call.harness.source.id, 'fsc_1');

    assert.equal(out.runId, 'dry_1');
    assert.equal(out.status, 'error');
    assert.equal(out.note, 'Shapes only. Read a value with automations_get_step_output.');
    assert.deepEqual(out.steps.map((s) => [s.stepId, s.stepType, s.status, s.durationMs]), [
        ['fp1', 'form_page', 'success', 1500],
        ['mail', 'gmail_compose', 'error', 100],
    ]);
    assert.equal(out.steps[0].output.present, true);
    assert.ok(out.steps[0].output.shape, 'a shape of the output');
    assert.equal(out.steps[1].output.present, false);
    // The synthetic secret rides in the scenario, the step output and an error text: none of it may appear.
    const json = JSON.stringify(out);
    assert.ok(!json.includes(SECRET), 'no scenario value in the result');
    assert.ok(!json.includes('someone@example.test'), 'no address from an error text');
});

test('an unknown scenario, a missing id and a wrong trigger are described refusals, not throws', async () => {
    const { tools, calls } = world();
    assert.equal((await tools.call('automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'nope' }, { userId: OWNER })).code, 'scenario_not_found');
    assert.equal((await tools.call('automations_dry_run_form_scenario', { automationId: 'auto_1' }, { userId: OWNER })).code, 'invalid_scenarioId');
    assert.equal((await tools.call('automations_list_form_scenarios', {}, { userId: OWNER })).code, 'invalid_automationId');
    const bad = await tools.call('automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'fsc_1', triggerStepId: 'zzz' }, { userId: OWNER });
    assert.equal(bad.code, 'invalid_trigger_step');
    assert.deepEqual(calls.execute, []);
    assert.match((await tools.call('nope', {}, { userId: OWNER })).error, /Unknown tool/);
});

test('a secondary trigger is entered when named', async () => {
    const { tools, calls } = world();
    await tools.call('automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'fsc_1', triggerStepId: 'trg2' }, { userId: OWNER });
    assert.equal(calls.execute[0].rootStepId, 'trg2');
});

test('a runner failure comes back as internal_error without its message', async () => {
    const broken = makeFormScenarioTools({
        store: { getAutomation: async () => ({ id: 'auto_1', userId: OWNER, organizationId: ORG, definition: { trigger: { id: 't', kind: 'manual' } } }) },
        getUser: async (id) => ({ id, organizationId: ORG }),
        testingStore: { getFormScenario: async () => SCENARIO },
        executeAutomation: async () => { throw new Error(`boom ${SECRET}`); },
    });
    const out = await broken.call('automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'fsc_1' }, { userId: OWNER });
    assert.equal(out.code, 'internal_error');
    assert.ok(!JSON.stringify(out).includes(SECRET));
});

test('a managed automation enters the live copy', async () => {
    const restore = configureStageVars({ managedInfo: async () => ({ stage: 'uat' }) });
    try {
        const live = { trigger: { id: 'trg_live', kind: 'manual' } };
        const a = { id: 'auto_1', userId: OWNER, organizationId: ORG, projectId: 'p1', kind: 'automation', version: 3, liveVersion: 2, definition: { trigger: { id: 'wc', kind: 'manual' }, triggers: [{ id: 'trg2', kind: 'webhook' }] } };
        Object.defineProperty(a, 'liveDefinition', { value: live, enumerable: false });
        const t = makeFormScenarioTools({
            store: { getAutomation: async () => a },
            getUser: async (id) => ({ id, organizationId: ORG }),
            testingStore: { getFormScenario: async () => SCENARIO },
            executeAutomation: async () => ({ id: 'dry_1', status: 'success' }),
        });
        const out = await t.call('automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'fsc_1', triggerStepId: 'trg2' }, { userId: OWNER });
        assert.equal(out.code, 'invalid_trigger_step', 'a trigger only in the working copy is not offered');
    } finally { restore(); }
});

test('a dry run over the per-user budget is refused with rate_limited and never starts a run', async () => {
    const { tools, calls } = world({ allowRun: async () => false });
    const out = await tools.call('automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'fsc_1' }, { userId: OWNER });
    assert.equal(out.code, 'rate_limited');
    assert.ok(out.error);
    assert.equal(calls.execute.length, 0);
    // Listing is a read and stays open.
    const list = await tools.call('automations_list_form_scenarios', { automationId: 'auto_1' }, { userId: OWNER });
    assert.equal(list.scenarios.length, 1);
});

test('the default limiter follows AUTOMATION_RUN_TRIGGER_RPM and 0 means unlimited', async () => {
    const saved = process.env.AUTOMATION_RUN_TRIGGER_RPM;
    try {
        process.env.AUTOMATION_RUN_TRIGGER_RPM = '2';
        const { tools, calls } = world();
        const run = () => tools.call('automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'fsc_1' }, { userId: OWNER });
        assert.equal((await run()).runId, 'dry_1');
        assert.equal((await run()).runId, 'dry_1');
        assert.equal((await run()).code, 'rate_limited');
        assert.equal(calls.execute.length, 2);

        process.env.AUTOMATION_RUN_TRIGGER_RPM = '0';
        const open = world();
        for (let i = 0; i < 5; i++) {
            assert.equal((await open.tools.call('automations_dry_run_form_scenario', { automationId: 'auto_1', scenarioId: 'fsc_1' }, { userId: OWNER })).runId, 'dry_1');
        }
    } finally {
        if (saved === undefined) delete process.env.AUTOMATION_RUN_TRIGGER_RPM; else process.env.AUTOMATION_RUN_TRIGGER_RPM = saved;
    }
});
