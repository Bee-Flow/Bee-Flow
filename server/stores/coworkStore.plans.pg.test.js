// @typecheck
/**
 * The plans of Cowork items, on the store's own schema and SQL (PGlite behind db.js): the automation a plan is made
 * from, the plan as approved (a new version per approval, the item pointing at the latest), taking a plan off, and
 * the link from a run to the automation run that holds its step trace.
 *
 * Run: cd server && node --test stores/coworkStore.plans.pg.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { coworkStoreOnPglite } = require('./coworkStore.testkit');

const { pg, store } = coworkStoreOnPglite();

const USER = 'u-plans';
const DEFINITION = { trigger: { id: 'trg', type: 'trigger', kind: 'schedule' }, steps: [{ id: 'a', type: 'set', values: {} }], edges: [{ from: 'trg', to: 'a' }] };
const PERMISSIONS = { v: 1, grants: [], sends: 'none', ai: false, outsideText: false };

async function item() {
    const s = await store.createSchedule({ userId: USER, title: 'Supplier radar', prompt: 'Summarise the supplier mail.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    return /** @type {{ id: string }} */ (s).id;
}

const approve = (scheduleId, over = {}) => store.approvePlan({ scheduleId, automationId: 'auto-1', definition: DEFINITION, permissions: PERMISSIONS, fingerprint: 'f'.repeat(64), approvedBy: USER, ...over });

test('a new item has no plan', async () => {
    const id = await item();
    const s = await store.getSchedule(id);
    assert.deepStrictEqual([s?.planAutomationId, s?.planId], [null, null]);
    assert.strictEqual(await store.getApprovedPlan(id), null);
});

test('naming the automation a plan is made from approves nothing', async () => {
    const id = await item();
    await store.attachPlanAutomation(id, 'auto-1');
    const s = await store.getSchedule(id);
    assert.deepStrictEqual([s?.planAutomationId, s?.planId], ['auto-1', null]);
    assert.strictEqual(await store.getApprovedPlan(id), null, 'a run still has no plan to execute');
});

test('approving writes the plan as approved, as version 1, and points the item at it', async () => {
    const id = await item();
    const plan = await approve(id);
    assert.strictEqual(plan.version, 1);
    assert.deepStrictEqual(plan.definition, DEFINITION);
    assert.deepStrictEqual(plan.permissions, PERMISSIONS);
    assert.strictEqual(plan.approvedBy, USER);
    assert.ok(plan.approvedAt);
    const s = await store.getSchedule(id);
    assert.deepStrictEqual([s?.planAutomationId, s?.planId], ['auto-1', plan.id]);
    assert.deepStrictEqual(await store.getApprovedPlan(id), plan);
});

test('a second approval is version 2; the item runs the latest and version 1 stays as history', async () => {
    const id = await item();
    const first = await approve(id);
    const changed = { ...DEFINITION, steps: [{ id: 'a', type: 'set', values: { x: 1 } }] };
    const second = await approve(id, { definition: changed, fingerprint: 'e'.repeat(64) });
    assert.strictEqual(second.version, 2);
    assert.deepStrictEqual((await store.getApprovedPlan(id))?.definition, changed);
    const { rows } = await pg.query('SELECT version, fingerprint FROM cowork_plans WHERE schedule_id = $1 ORDER BY version', [id]);
    assert.deepStrictEqual(rows, [{ version: 1, fingerprint: first.fingerprint }, { version: 2, fingerprint: second.fingerprint }]);
});

test('the approved copy is its own: a later change to what was handed in does not reach it', async () => {
    const id = await item();
    const definition = JSON.parse(JSON.stringify(DEFINITION));
    await approve(id, { definition });
    definition.steps.push({ id: 'evil', type: 'integration_action', tool: 'gmail_compose' });
    assert.deepStrictEqual((await store.getApprovedPlan(id))?.definition, DEFINITION);
});

test('taking the plan off clears both pointers and keeps the approved versions', async () => {
    const id = await item();
    await approve(id);
    await store.detachPlan(id);
    const s = await store.getSchedule(id);
    assert.deepStrictEqual([s?.planAutomationId, s?.planId], [null, null]);
    assert.strictEqual(await store.getApprovedPlan(id), null);
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM cowork_plans WHERE schedule_id = $1', [id]);
    assert.strictEqual(rows[0].n, 1);
});

test('a plan belongs to its item: one item never runs another item\'s approved plan', async () => {
    const mine = await item();
    const other = await item();
    const plan = await approve(other);
    // A pointer at another item's plan, as a bug or a tampered row would leave it.
    await pg.query('UPDATE cowork_schedules SET plan_id = $2 WHERE id = $1', [mine, plan.id]);
    assert.strictEqual(await store.getApprovedPlan(mine), null);
    assert.ok(await store.getApprovedPlan(other));
});

test('approving for an item that does not exist writes nothing', async () => {
    await assert.rejects(approve('no-such-item'), /does not exist/);
    const { rows } = await pg.query(`SELECT COUNT(*)::int AS n FROM cowork_plans WHERE schedule_id = 'no-such-item'`);
    assert.strictEqual(rows[0].n, 0);
});

test('deleting an item deletes its approved plans', async () => {
    const id = await item();
    await approve(id);
    await store.deleteSchedule(id);
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM cowork_plans WHERE schedule_id = $1', [id]);
    assert.strictEqual(rows[0].n, 0);
});

test('a run of a plan records which plan it ran and the automation run behind it', async () => {
    const id = await item();
    const plan = await approve(id);
    const runId = await store.markRunning(id, { triggerKind: 'manual' });
    await store.linkPlanRun(runId, { planId: plan.id });
    await store.linkPlanRun(runId, { planId: plan.id, automationRunId: 'arun-1' });
    await store.linkPlanRun(runId, { planId: plan.id }); // a later note without the run id keeps it
    await store.linkPlanRun(null, { planId: plan.id });
    const { rows } = await pg.query('SELECT plan_id, automation_run_id FROM cowork_runs WHERE id = $1', [runId]);
    assert.deepStrictEqual(rows, [{ plan_id: plan.id, automation_run_id: 'arun-1' }]);
});

test('the plan a run followed is read as it was approved then, with the automation run behind it; a later approval does not rewrite it', async () => {
    const id = await item();
    const first = await approve(id);
    const runId = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.linkPlanRun(runId, { planId: first.id, automationRunId: 'arun-7' });
    await store.markCompleted(id, 'Done.', { runId });
    await approve(id, { definition: { ...DEFINITION, steps: [] }, fingerprint: 'e'.repeat(64) });
    assert.deepStrictEqual(await store.getPlanRun(id, runId), { runId, automationRunId: 'arun-7', plan: first });
    const listed = await store.listRuns(id);
    assert.strictEqual(listed[0]?.planId, first.id, 'the history says the run followed a plan');
});

test('a run that followed no plan has none, a run that never started its automation has no automation run, and a run is its own item\'s', async () => {
    const id = await item();
    const plan = await approve(id);
    const plain = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    assert.strictEqual(await store.getPlanRun(id, plain), null, 'no plan on this run');
    await store.linkPlanRun(plain, { planId: plan.id });
    assert.deepStrictEqual(await store.getPlanRun(id, plain), { runId: plain, automationRunId: null, plan });

    const other = await item();
    assert.strictEqual(await store.getPlanRun(other, plain), null, 'asked through another item');
    assert.strictEqual(await store.getPlanRun(id, 'no-such-run'), null);
    assert.strictEqual((await store.listRuns(other)).length, 0);
});

test('a plan run that waits for a decision closes as waiting: not counted as a failure, listed for the follow-up, closed once', async () => {
    const id = await item();
    const plan = await approve(id);
    const runId = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.linkPlanRun(runId, { planId: plan.id, automationRunId: 'arun-wait' });
    await store.markCompleted(id, 'This run is waiting for a decision.', { runId, waiting: true });

    assert.strictEqual((await store.listRuns(id))[0]?.status, 'waiting');
    assert.deepStrictEqual(await store.getRunStats(id).then((st) => [st.total, st.success, st.failed]), [1, 0, 0]);
    assert.ok((await store.listWaitingRuns(100)).some((w) => w.id === runId && w.automationRunId === 'arun-wait'));
    const found = await store.getPlanOfAutomationRun('arun-wait');
    assert.deepStrictEqual([found?.runId, found?.userId, found?.title, found?.id], [runId, USER, 'Supplier radar', plan.id]);
    assert.strictEqual(await store.getPlanOfAutomationRun('arun-unknown'), null);

    assert.strictEqual(await store.closeWaitingRun(runId, { status: 'success', result: 'Sent the digest.', error: null }), true);
    assert.strictEqual(await store.closeWaitingRun(runId, { status: 'error', result: null, error: 'late' }), false, 'closed once');
    const [closed] = await store.listRuns(id);
    assert.deepStrictEqual([closed?.status, closed?.result, closed?.error, closed?.producedOutput], ['success', 'Sent the digest.', null, true]);
    assert.ok(!(await store.listWaitingRuns(100)).some((w) => w.id === runId));
});
