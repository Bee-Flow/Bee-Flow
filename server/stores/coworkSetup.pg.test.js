// @typecheck
/**
 * A task's set-up on the store's own schema and SQL (PGlite behind db.js): what its owner chose stays with the item,
 * a one-off that waits for its steps is not due, "let the AI work it out every run" takes the plan off in one
 * statement and its Undo puts back the plan and the approval, and taking a plan off releases a task that waited.
 *
 * Run: cd server && node --test stores/coworkSetup.pg.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { coworkStoreOnPglite } = require('./coworkStore.testkit');

const { store } = coworkStoreOnPglite();
const { makeCoworkSetup } = require('./coworkSetupStore.mts');
const setup = makeCoworkSetup({ ready: () => store.initDB() });

const USER = 'u-setup';
const PAST = new Date(Date.now() - 60_000).toISOString();

/** @param {Record<string, unknown>} [over] */
async function item(over = {}) {
    const s = await store.createSchedule({ userId: USER, title: 'Meeting overview', prompt: 'Summarise my meetings.', repeatInterval: null, nextRunAt: PAST, ...over });
    return /** @type {{ id: string }} */ (s).id;
}

const dueIds = async () => (await store.getDueSchedules()).map((s) => s?.id);
const approve = (/** @type {string} */ scheduleId) => store.approvePlan({ scheduleId, automationId: 'auto-1', definition: { steps: [] }, permissions: {}, fingerprint: 'f'.repeat(64), approvedBy: USER });

test('a task nobody set up this way has no set-up; what its owner chose is read back with the item', async () => {
    const id = await item();
    assert.strictEqual((await store.getSchedule(id))?.setup, null);
    await setup.writeSetup(id, 'wanted', { since: '2026-11-24T12:00:00.000Z', sendsTo: { me: true, others: ['sam@example.com'] }, askFirst: true });
    assert.deepStrictEqual((await store.getSchedule(id))?.setup, {
        steps: 'wanted', cause: null, since: '2026-11-24T12:00:00.000Z', sendsTo: { me: true, others: ['sam@example.com'] }, askFirst: true, canUndo: false,
    });
    assert.deepStrictEqual(await setup.readSetup(id), { state: 'wanted', record: { since: '2026-11-24T12:00:00.000Z', sendsTo: { me: true, others: ['sam@example.com'] }, askFirst: true } });
    assert.strictEqual(await setup.readSetup('no-such-item'), null);
});

test('a one-off that waits for its steps is not due; it is once they are approved, or once its owner chose the AI', async () => {
    const waiting = await item();
    const failed = await item();
    const plain = await item();
    await setup.writeSetup(waiting, 'wanted', {});
    await setup.writeSetup(failed, 'failed', { cause: 'timeout' });
    let due = await dueIds();
    assert.ok(due.includes(plain), 'a task that was not set up this way runs as it always did');
    assert.ok(!due.includes(waiting) && !due.includes(failed), 'neither runs on its own before its owner chose');

    await approve(waiting);
    await setup.detachForAi(failed, { was: { state: 'failed', cause: 'timeout', planAutomationId: null, planId: null } });
    due = await dueIds();
    assert.ok(due.includes(waiting) && due.includes(failed));
});

test('a repeating task that waits is still read, so the runner can move its moment on without running it', async () => {
    const id = await item({ repeatInterval: 'daily' });
    await setup.writeSetup(id, 'wanted', {});
    assert.ok((await dueIds()).includes(id));
});

test('"let the AI work it out every run" takes the plan off; Undo puts back the plan and its approval', async () => {
    const id = await item();
    const plan = await approve(id);
    const was = { state: null, cause: null, planAutomationId: 'auto-1', planId: plan.id };
    await setup.detachForAi(id, { was });
    let s = await store.getSchedule(id);
    assert.deepStrictEqual([s?.planAutomationId, s?.planId, s?.setup?.steps, s?.setup?.canUndo], [null, null, 'ai', true]);

    await setup.restoreFromAi(id, was, {});
    s = await store.getSchedule(id);
    assert.deepStrictEqual([s?.planAutomationId, s?.planId, s?.setup], ['auto-1', plan.id, null]);
    assert.strictEqual((await store.getApprovedPlan(id))?.id, plan.id);
});

test('Undo never points a task at a plan that is not its own', async () => {
    const mine = await item();
    const other = await item();
    const theirs = await approve(other);
    await setup.restoreFromAi(mine, { state: 'wanted', cause: null, planAutomationId: 'auto-1', planId: theirs.id }, {});
    const s = await store.getSchedule(mine);
    assert.deepStrictEqual([s?.planAutomationId, s?.planId, s?.setup?.steps], ['auto-1', null, 'wanted']);
});

test('taking the plan off a task that waited for its steps is its owner choosing the AI: it waits no longer', async () => {
    const id = await item();
    await setup.writeSetup(id, 'wanted', {});
    await store.attachPlanAutomation(id, 'auto-1');
    await store.detachPlan(id);
    assert.strictEqual((await store.getSchedule(id))?.setup?.steps, 'ai');
    assert.ok((await dueIds()).includes(id));

    const legacy = await item();
    await store.detachPlan(legacy);
    assert.strictEqual((await store.getSchedule(legacy))?.setup, null, 'a task without a set-up gets none');
});
