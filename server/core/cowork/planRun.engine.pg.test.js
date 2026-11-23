/**
 * A plan from approval to its history, on the REAL automation engine and the real stores (PGlite behind db.js):
 * nothing is mocked and nothing is handed in. What the unit tests prove with a fake runner is proven here against
 * the runner itself:
 *
 *   - a run executes the plan AS APPROVED, not the automation's definition of the moment;
 *   - its steps are recorded, linked to the Cowork run and readable as the run's trace;
 *   - the plan's own result reaches the owner once, and the automation's notification settings reach nobody;
 *   - a try-out runs the same plan and delivers nothing.
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

const automationStore = require('../../stores/automationStore');
const { executeTask } = require('../aiTaskRunner');
const { attachPlan, approvePlan, planStateOf } = require('../../usecases/coworkPlan.mts');
const { runTraceOf } = require('../../usecases/coworkRunTrace.mts');
const { startTry, tryStateOf } = require('../../usecases/coworkPlanTry.mts');


const USER = 'u-plan-engine';

const literal = (value) => ({ kind: 'literal', value });

/** trigger → pick the numbers → tell the owner. The automation's own settings name a room and another person. */
function definition(label = 'three orders') {
    return {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [
            { id: 'facts', type: 'set', label: 'Collect the figures', fields: { overdue: literal(3), what: literal(label) } },
            { id: 'tell', type: 'notification', label: 'Send me the digest', title: 'Supplier radar', body: '{{steps.facts.output.what}} are overdue', channels: ['notification'] },
        ],
        edges: [{ from: 'trg', to: 'facts' }, { from: 'facts', to: 'tell' }],
        vars: {},
        notificationSettings: {
            onSuccess: { enabled: true, channels: ['bell', 'talk'], recipients: [{ type: 'user', id: 'someone-else' }], talkRoom: 'ops-room' },
            onError: { enabled: true, channels: ['bell'], recipients: [{ type: 'user', id: 'someone-else' }] },
        },
    };
}

async function itemWithPlan() {
    const automation = await automationStore.createAutomation({ userId: USER, title: 'Supplier radar', definition: definition(), triggerType: 'manual' });
    const schedule = await store.createSchedule({ userId: USER, title: 'Supplier radar', prompt: 'Tell me what is overdue.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
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
