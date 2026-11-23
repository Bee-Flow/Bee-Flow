/**
 * A plan from approval to its history, on the REAL automation engine and the real stores (PGlite behind db.js):
 * nothing is mocked and nothing is handed in. What the unit tests prove with a fake runner is proven here against
 * the runner itself:
 *
 *   - a run executes the plan AS APPROVED, not the automation's definition of the moment;
 *   - its steps are recorded, linked to the Cowork run and readable as the run's trace;
 *   - the plan's own result reaches the owner once, and the automation's notification settings reach nobody;
 *   - a try-out runs the same plan and delivers nothing;
 *   - a plan that waits for its owner's decision closes as 'waiting', continues after the approval on the plan as
 *     approved (also when the automation changed meanwhile), and its Cowork run is closed when the journey ends.
 *
 * The plan holds only steps that need no connected app and no model, so the run is the engine's own work.
 *
 * Run: cd server && node --test core/cowork/planRun.engine.pg.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { pg, store } = require('../../stores/coworkStore.testkit').coworkStoreOnPglite();

// What boot registers for the server: the runner reaches these features through its ports.
require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');
require('./runnerPorts'); // Cowork's own: a plan's journey keeps its approved copy across a pause

const automationStore = require('../../stores/automationStore');
const { executeTask } = require('../aiTaskRunner');
const { attachPlan, approvePlan, planStateOf } = require('../../usecases/coworkPlan.mts');
const { runTraceOf } = require('../../usecases/coworkRunTrace.mts');
const { startTry, tryStateOf } = require('../../usecases/coworkPlanTry.mts');


const USER = 'u-plan-engine';

const literal = (value) => ({ kind: 'literal', value });

/**
 * trigger → pick the numbers → (ask the owner) → tell the owner. The automation's own settings name a room and
 * another person.
 */
function definition(label = 'three orders', { ask = false, tellBody = '{{steps.facts.output.what}} are overdue' } = {}) {
    const steps = [
        { id: 'facts', type: 'set', label: 'Collect the figures', fields: { overdue: literal(3), what: literal(label) } },
        ...(ask ? [{ id: 'ask', type: 'approval', label: 'Ask me first', prompt: 'Send the digest about {{steps.facts.output.what}}?' }] : []),
        { id: 'tell', type: 'notification', label: 'Send me the digest', title: 'Supplier radar', body: tellBody, channels: ['notification'] },
    ];
    const ids = ['trg', ...steps.map((x) => x.id)];
    return {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps,
        edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })),
        vars: {},
        notificationSettings: {
            onSuccess: { enabled: true, channels: ['bell', 'talk'], recipients: [{ type: 'user', id: 'someone-else' }], talkRoom: 'ops-room' },
            onError: { enabled: true, channels: ['bell'], recipients: [{ type: 'user', id: 'someone-else' }] },
        },
    };
}

async function itemWithPlan(over = {}, userId = USER) {
    const automation = await automationStore.createAutomation({ userId, title: 'Supplier radar', definition: definition('three orders', over), triggerType: 'manual' });
    const schedule = await store.createSchedule({ userId, title: 'Supplier radar', prompt: 'Tell me what is overdue.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const item = await store.getSchedule(schedule.id);
    const attached = await attachPlan({ item, automationId: automation.id });
    return { automation, item: await store.getSchedule(item.id), attached };
}

const notificationsOf = async (userId) => (await pg.query('SELECT title, message FROM notifications WHERE user_id = $1 ORDER BY created_at', [userId])).rows;

test('an approved plan runs on the engine as approved, its steps become the run\'s trace, and only its owner hears', async () => {
    const { automation, item, attached } = await itemWithPlan();
    assert.deepStrictEqual(attached.draft.findings, [], 'the plan is one Cowork runs');
    const approved = await approvePlan({ item, fingerprint: attached.draft.fingerprint });
    assert.strictEqual(approved.upToDate, true);

    // The automation changes after the approval: the run must not see it.
    await automationStore.updateAutomation(automation.id, { definition: definition('SEVEN orders') }, USER);
    assert.strictEqual((await planStateOf(await store.getSchedule(item.id))).upToDate, false, 'the card says the plan changed');

    await executeTask(await store.getSchedule(item.id), { manual: true, store });

    const [run] = await store.listRuns(item.id);
    assert.strictEqual(run.status, 'success', `the run succeeded (${run.error})`);
    assert.ok(run.planId, 'the run says which plan it followed');

    const trace = await runTraceOf({ item, runId: run.id });
    assert.deepStrictEqual([trace.recorded, trace.done, trace.planVersion], [true, true, 1]);
    assert.deepStrictEqual(trace.steps.map((s) => [s.id, s.status, s.held]), [['facts', 'success', false], ['tell', 'success', false]]);
    assert.match(trace.steps[0].preview, /three orders/, 'the approved copy ran, not the changed automation');
    assert.match(trace.steps[1].preview, /three orders are overdue/, 'a step that sends shows what went into it');

    const mine = await notificationsOf(USER);
    assert.deepStrictEqual(mine.map((n) => [n.title, n.message]), [['Supplier radar', 'three orders are overdue']], 'the plan\'s own result, once');
    assert.deepStrictEqual(await notificationsOf('someone-else'), [], 'the automation\'s own settings reached nobody');
});

test('a try-out runs the plan as it is now and delivers nothing', async () => {
    const { item } = await itemWithPlan();
    const before = (await notificationsOf(USER)).length;
    const { tryId, fingerprint } = await startTry({ item });
    assert.strictEqual(fingerprint, (await planStateOf(item)).draft.fingerprint);

    let state = await tryStateOf({ item, tryId });
    for (let i = 0; i < 100 && !state.done; i++) {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        state = await tryStateOf({ item, tryId });
    }
    assert.strictEqual(state.status, 'success', `the try-out finished (${state.error})`);
    assert.deepStrictEqual(state.steps.map((s) => [s.id, s.status, s.held]), [['facts', 'success', false], ['tell', 'success', true]]);
    assert.match(state.steps[1].preview, /three orders are overdue/, 'what it would have sent');
    assert.strictEqual((await notificationsOf(USER)).length, before, 'nothing was delivered');
    assert.deepStrictEqual(await store.listRuns(item.id), [], 'a try-out is no run of the item');
});

test('a plan that waits for its owner continues on the approved copy after the decision, and its Cowork run is closed', async () => {
    const followUp = require('./planRunFollowUp.mts');
    // Approvals are an Enterprise capability (core/automationRunner/dryPause.mts): this server is licensed for them.
    const { setPauseDepsForTests } = require('../automationRunner/dryPause.mts');
    setPauseDepsForTests({ hasCapability: async (capId) => capId === 'approvals' });
    followUp.start();
    try {
        const OWNER = 'u-plan-engine-ask';
        const { automation, item, attached } = await itemWithPlan({ ask: true }, OWNER);
        assert.deepStrictEqual(attached.draft.findings, [], 'an approval that asks the owner is part of a plan');
        await approvePlan({ item, fingerprint: attached.draft.fingerprint });

        // The automation changes after the approval, before the run: the run is recorded on that newer version, and
        // without the held copy the steps after the pause would come from it (and so would its notification settings).
        await automationStore.updateAutomation(automation.id, { definition: definition('SEVEN orders', { ask: true, tellBody: 'CHANGED: {{steps.facts.output.what}}' }) }, OWNER);

        await executeTask(await store.getSchedule(item.id), { manual: true, store });
        const [waiting] = await store.listRuns(item.id);
        assert.strictEqual(waiting.status, 'waiting', `the run waits for the decision (${waiting.error})`);

        const link = await store.getPlanRun(item.id, waiting.id);
        const run = await automationStore.getRun(link.automationRunId);
        const approval = await automationStore.getApprovalForRunStep(link.automationRunId, 'ask', { pendingOnly: true });
        assert.ok(approval, 'the approval is there to decide');
        assert.match(approval.prompt || '', /three orders/);
        const decided = await require('../../automation/approvalService').decide({ approval, run, deciderId: OWNER, decision: 'approve', source: 'studio' });
        assert.deepStrictEqual([decided.code, decided.body.accepted], [200, true], JSON.stringify(decided).slice(0, 300));
        assert.strictEqual(decided.body.run.status, 'success', 'the journey went on after the decision');

        let closed = (await store.listRuns(item.id))[0];
        for (let i = 0; i < 100 && closed.status === 'waiting'; i++) {
            await new Promise((resolve) => { setTimeout(resolve, 50); });
            closed = (await store.listRuns(item.id))[0];
        }
        assert.strictEqual(closed.status, 'success', `closed after the decision (${closed.error})`);

        const trace = await runTraceOf({ item, runId: closed.id });
        assert.deepStrictEqual(trace.steps.map((x) => [x.id, x.status]), [['facts', 'success'], ['ask', 'success'], ['tell', 'success']]);
        assert.match(trace.steps[2].preview, /three orders are overdue/, 'the continuation ran the approved copy');

        const mine = (await notificationsOf(OWNER)).map((n) => n.message || '');
        assert.strictEqual(mine.filter((m) => m === 'three orders are overdue').length, 1, 'the result reached the owner once');
        assert.ok(!mine.some((m) => m.includes('SEVEN') || m.includes('CHANGED')), 'nothing of the changed automation ran');
        assert.deepStrictEqual(await notificationsOf('someone-else'), [], 'the automation\'s own settings reached nobody');
    } finally {
        followUp.stop();
        setPauseDepsForTests(null);
    }
});
