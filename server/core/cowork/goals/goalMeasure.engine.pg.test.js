/**
 * A goal measured on the REAL automation engine and the real stores (PGlite behind db.js): nothing is mocked and
 * nothing is handed in. A cowork with an approved plan runs, its end is announced the way the Cowork runner announces
 * it, and the measuring listener runs the approved check:
 *
 *   - the check's run records zero writes and zero sends: every step it ran reads, it is a dry run, nothing reached
 *     anyone;
 *   - met and total are stored, counted with working days;
 *   - a check that fails leaves the cowork's run successful, and is kept as a failed measurement with its reason;
 *   - a check that would send is refused at approval.
 *
 * Run: cd server && node --test core/cowork/goals/goalMeasure.engine.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pg, store } = require('../coworkEngine.testkit').coworkOnEngine();

const automationStore = require('../../../stores/automationStore');
const goalsStore = require('../../../stores/coworkGoals.mts');
const { executeTask } = require('../../aiTaskRunner');
const { attachPlan, approvePlan } = require('../../../usecases/coworkPlan.mts');
const { saveGoal, goalOf, approveCheck } = require('../../../usecases/coworkGoals.mts');
const { planViewOf } = require('../plan/planView.mts');
const { toolLookups } = require('../plan/planLookups.mts');
const { runEnded } = require('../runEnded.mts');
const measuring = require('./goalMeasure.mts');

const USER = 'u-goal-engine';
const literal = (value) => ({ kind: 'literal', value });
const expr = (value) => ({ kind: 'expr', value });

/** A definition from a list of steps, wired in order from a manual trigger. */
const wired = (steps) => {
    const ids = ['trg', ...steps.map((s) => s.id)];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })), vars: {} };
};

// Mail of the week: received on a Friday, answered on Monday (1 working day), on Tuesday (2) and on Thursday (4).
const MAIL = [
    { receivedAt: '2026-11-20T16:00:00Z', answeredAt: '2026-11-23T09:00:00Z' },
    { receivedAt: '2026-11-20T16:00:00Z', answeredAt: '2026-11-24T09:00:00Z' },
    { receivedAt: '2026-11-20T16:00:00Z', answeredAt: '2026-11-26T09:00:00Z' },
];
const COUNT = { id: 'count', type: 'set', label: 'Count the answers in time', fields: {
    met: expr('len(filter(steps.mail.output.messages, workdaysBetween(it.receivedAt, it.answeredAt) <= 2))'),
    total: expr('len(steps.mail.output.messages)'),
    period: literal('this week'),
} };
const CHECK = wired([{ id: 'mail', type: 'set', label: 'The supplier mail of the week', fields: { messages: literal(MAIL) } }, COUNT]);
// The same check with a step that stops the run: a check that fails.
const FAILING = wired([{ id: 'mail', type: 'set', label: 'The supplier mail of the week', fields: { messages: literal(MAIL) } }, { id: 'halt', type: 'stop_error', label: 'Stop', message: 'The mailbox could not be read.' }, COUNT]);

before(async () => { await goalsStore.initDB(); });
after(() => { measuring.stop(); });

/** An item of USER with an approved plan (one fixed step and a notification to its owner). */
async function itemWithPlan(title) {
    const plan = wired([
        { id: 'facts', type: 'set', label: 'Collect the figures', fields: { overdue: literal(3) } },
        { id: 'tell', type: 'notification', label: 'Tell me', title, body: '{{steps.facts.output.overdue}} are overdue', channels: ['notification'] },
    ]);
    const automation = await automationStore.createAutomation({ userId: USER, title, definition: plan, triggerType: 'manual' });
    const schedule = await store.createSchedule({ userId: USER, title, prompt: 'Tell me what is overdue.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const attached = await attachPlan({ item: await store.getSchedule(schedule.id), automationId: automation.id });
    await approvePlan({ item: await store.getSchedule(schedule.id), fingerprint: attached.draft.fingerprint });
    return store.getSchedule(schedule.id);
}

/** Give the item a goal whose check is `definition`, approved as read. */
async function withGoal(item, definition) {
    await saveGoal({ item, sentence: 'Every supplier mail gets an answer within two working days', targetPercent: 95 });
    const check = await automationStore.createAutomation({ userId: USER, title: 'Goal check', definition, triggerType: 'manual' });
    await goalsStore.coworkGoals().setCheck(item.id, check.id);
    const { goal } = await goalOf(item);
    return { check, goal };
}

const notificationsOf = async () => (await pg.query('SELECT title FROM notifications WHERE user_id = $1', [USER])).rows;

/** Run the item, announce its end as the Cowork runner does, and wait for the goal to be measured. */
async function runAndMeasure(item) {
    await executeTask(await store.getSchedule(item.id), { manual: true, store });
    const [run] = await store.listRuns(item.id);
    // What the cowork's own run delivered, before its goal is measured.
    const sentByRun = (await notificationsOf()).length;
    runEnded(item, run.id);
    let results = [];
    for (let i = 0; i < 200 && results.length === 0; i++) {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        results = await goalsStore.coworkGoals().listResults(item.id);
    }
    return { run, results, sentByRun };
}

test('a measured run reads only, sends nothing, and stores met and total', async () => {
    measuring.start();
    const item = await itemWithPlan('Supplier radar');
    const { check, goal } = await withGoal(item, CHECK);
    assert.deepStrictEqual([goal.check.readsOnly, goal.check.findings], [true, []]);
    await approveCheck({ item, fingerprint: goal.check.fingerprint });

    const { run, results, sentByRun } = await runAndMeasure(item);
    assert.strictEqual(run.status, 'success', `the cowork run succeeded (${run.error})`);
    assert.deepStrictEqual(results.map((r) => [r.runId, r.met, r.total, r.period, r.ok, r.error]), [[run.id, 2, 3, 'this week', true, null]]);

    // The check's own run: a dry run of the check automation, every step it ran a read.
    const { rows: checkRuns } = await pg.query('SELECT id, mode, status FROM automation_runs WHERE automation_id = $1', [check.id]);
    assert.deepStrictEqual(checkRuns.map((r) => [r.mode, r.status]), [['dry_run', 'success']]);
    const { rows: steps } = await pg.query('SELECT step_id FROM automation_run_steps WHERE run_id = $1 ORDER BY step_id', [checkRuns[0].id]);
    assert.deepStrictEqual(steps.map((s) => s.step_id), ['count', 'mail']);
    const effects = planViewOf(CHECK, toolLookups()).steps.filter((s) => steps.some((r) => r.step_id === s.id)).map((s) => s.effect);
    assert.deepStrictEqual([effects.filter((e) => e === 'writes').length, effects.filter((e) => e === 'sends').length], [0, 0], 'zero writes, zero sends');
    assert.strictEqual((await notificationsOf()).length, sentByRun, 'the check delivered nothing');

    const shown = (await goalOf(item)).goal;
    assert.deepStrictEqual([shown.count.met, shown.count.total, shown.count.percent], [2, 3, 67]);
});

test('a check that fails leaves the cowork run successful and is kept as a failed measurement', async () => {
    measuring.start();
    const item = await itemWithPlan('Order log');
    const { goal } = await withGoal(item, FAILING);
    await approveCheck({ item, fingerprint: goal.check.fingerprint });

    const { run, results } = await runAndMeasure(item);
    assert.strictEqual(run.status, 'success', 'the cowork run is not touched by its goal');
    assert.strictEqual((await store.listRuns(item.id))[0].status, 'success');
    assert.deepStrictEqual(results.map((r) => [r.runId, r.ok, r.met, r.total]), [[run.id, false, null, null]]);
    assert.match(results[0].error, /^The check did not finish/);
});

test('a check that would send is refused at approval on the real stores', async () => {
    const item = await itemWithPlan('Weekly digest');
    const sending = wired([{ id: 'tell', type: 'notification', label: 'Tell me', title: 'x', body: 'y', channels: ['notification'] }, COUNT]);
    const { goal } = await withGoal(item, sending);
    assert.strictEqual(goal.check.readsOnly, false);
    await assert.rejects(approveCheck({ item, fingerprint: goal.check.fingerprint }), (e) => e.status === 422 && /A goal's check/.test(e.message));
    assert.strictEqual((await goalsStore.coworkGoals().getGoal(item.id)).approvedDefinition, null);
});
