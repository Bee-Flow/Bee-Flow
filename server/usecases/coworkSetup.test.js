// @typecheck
/**
 * A task's set-up from the routes' side (./coworkSetup.mts): what its owner chose on the confirmation is kept with it,
 * a set-up that fails or is left never turns it into "the AI does it", and "let the AI work it out every run" can be
 * undone exactly. The store is one in memory with the real store's four calls, so nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkSetup.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { startSetup, setupStarted, setupFailed, chooseMode } = require('./coworkSetup.mts');
const { heldForSetup } = require('../core/cowork/taskSetup.mts');
const { setupViewOf } = require('../stores/coworkSetup.mts');
const { HttpError } = require('../core/http/errors');

const NOW = new Date('2026-11-24T12:00:00.000Z');

/**
 * The item's row as the real columns hold it, and the store over it.
 * @param {{ mayAsk?: boolean, stepsAvailable?: boolean, state?: string | null, record?: Record<string, unknown>, planAutomationId?: string | null, planId?: string | null }} [how]
 */
function world({ mayAsk = true, stepsAvailable = true, state = null, record = {}, planAutomationId = null, planId = null } = {}) {
    const row = /** @type {any} */ ({ id: 'cw-1', userId: 'u1', setup_state: state, record: { ...record }, planAutomationId, planId, independence: null });
    const deps = /** @type {any} */ ({
        store: {
            readSetup: async () => ({ state: row.setup_state, record: { ...row.record } }),
            writeSetup: async (_id, next, rec) => { row.setup_state = next; row.record = { ...rec }; },
            detachForAi: async (_id, rec) => { row.setup_state = 'ai'; row.record = { ...rec }; row.planAutomationId = null; row.planId = null; },
            restoreFromAi: async (_id, was, rec) => { row.setup_state = was.state; row.record = { ...rec }; row.planAutomationId = was.planAutomationId; row.planId = was.planId; },
        },
        setIndependence: async (_id, level) => { row.independence = level; },
        mayAsk: async () => mayAsk,
        stepsAvailable: async () => stepsAvailable,
        now: () => NOW,
    });
    /** The item as a route loads it. */
    const item = () => ({ id: row.id, userId: row.userId, planAutomationId: row.planAutomationId, planId: row.planId, setup: setupViewOf(row.setup_state, JSON.stringify(row.record)) });
    return { row, deps, item };
}

test('a new task keeps what its owner chose: it waits for its steps, sends to me and sam, and shows each message first', async () => {
    const w = world();
    const setup = await startSetup({ item: w.item(), chosen: { steps: true, sendsTo: ['me', 'sam@example.com'], askFirst: true } }, w.deps);
    assert.deepStrictEqual(setup, { steps: 'wanted', cause: null, since: NOW.toISOString(), sendsTo: { me: true, others: ['sam@example.com'] }, askFirst: true, canUndo: false });
    assert.strictEqual(w.row.independence, 'asks_before_sending', 'the wish is its level from the first run on');
    assert.strictEqual(heldForSetup(w.item()), true, 'it does not run before its steps are approved');
});

test('"show me each message first" is only set where a task can ask at all; the wish stays with the task', async () => {
    const w = world({ mayAsk: false });
    const setup = await startSetup({ item: w.item(), chosen: { steps: true, sendsTo: ['sam@example.com'], askFirst: true } }, w.deps);
    assert.strictEqual(w.row.independence, null);
    assert.strictEqual(setup?.askFirst, true);
    assert.deepStrictEqual(setup?.sendsTo, { me: false, others: ['sam@example.com'] }, 'its owner took "me" off');

    const off = world();
    await startSetup({ item: off.item(), chosen: { steps: true, askFirst: false } }, off.deps);
    assert.strictEqual(off.row.independence, null, 'switched off: no level is chosen for them');
});

test('an owner who cannot have fixed steps gets a task the AI works out, said in the answer; nothing chosen stores nothing', async () => {
    const w = world({ stepsAvailable: false });
    const setup = await startSetup({ item: w.item(), chosen: { steps: true, sendsTo: ['me'] } }, w.deps);
    assert.strictEqual(setup?.steps, null);
    assert.strictEqual(heldForSetup(w.item()), false);

    const none = world();
    assert.strictEqual(await startSetup({ item: none.item(), chosen: undefined }, none.deps), null);
    assert.strictEqual(none.row.setup_state, null);
});

test('a set-up that fails, or that its owner left, leaves the task waiting with the class of what went wrong', async () => {
    const w = world({ state: 'wanted', record: { since: '2026-11-24T11:00:00.000Z', sendsTo: { me: true, others: [] } } });
    await setupFailed({ item: w.item(), err: new HttpError(504, 'cowork_planner_timeout', 'Making the plan took too long.') }, w.deps);
    assert.deepStrictEqual([w.row.setup_state, w.row.record.cause], ['failed', 'timeout']);
    assert.strictEqual(heldForSetup(w.item()), true, 'it is not switched to the AI by itself');
    assert.deepStrictEqual(w.row.record.sendsTo, { me: true, others: [] }, 'what its owner chose stays');

    await setupStarted(w.item(), w.deps);
    assert.deepStrictEqual([w.row.setup_state, w.row.record.cause, w.row.record.since], ['wanted', undefined, NOW.toISOString()], 'trying again starts over');

    await setupFailed({ item: w.item(), err: new Error('socket hang up'), left: true }, w.deps);
    assert.deepStrictEqual([w.row.setup_state, w.row.record.cause], ['failed', 'left']);
});

test('a task that ran with the AI already stays as it ran when a plan could not be made for it', async () => {
    const legacy = world();
    await setupStarted(legacy.item(), legacy.deps);
    await setupFailed({ item: legacy.item(), err: new Error('no') }, legacy.deps);
    assert.strictEqual(legacy.row.setup_state, null);

    const chosen = world({ state: 'ai' });
    await setupFailed({ item: chosen.item(), err: new Error('no') }, chosen.deps);
    assert.strictEqual(chosen.row.setup_state, 'ai');

    const planned = world({ state: 'wanted', planAutomationId: 'auto-1' });
    await setupFailed({ item: planned.item(), err: new HttpError(409, 'cowork_plan_refused', 'This item already has a plan.') }, planned.deps);
    assert.strictEqual(planned.row.setup_state, 'wanted', 'it has steps: nothing failed');
});

test('"let the AI work it out every run" releases the task, and Undo puts back the card it came from', async () => {
    const w = world({ state: 'failed', record: { cause: 'unclear', sendsTo: { me: true, others: ['sam@example.com'] } } });
    const ai = await chooseMode({ item: w.item(), mode: 'ai' }, w.deps);
    assert.deepStrictEqual([ai?.steps, ai?.canUndo], ['ai', true]);
    assert.strictEqual(heldForSetup(w.item()), false, 'the AI may do it now');
    assert.deepStrictEqual(ai?.sendsTo, { me: true, others: ['sam@example.com'] });

    const back = await chooseMode({ item: w.item(), mode: 'steps' }, w.deps);
    assert.deepStrictEqual([back?.steps, back?.cause, back?.canUndo], ['failed', 'unclear', false]);
    assert.strictEqual(heldForSetup(w.item()), true, 'it waits for its owner again');
});

test('Undo brings back the steps a task had, with the approval they had', async () => {
    const w = world({ planAutomationId: 'auto-1', planId: 'plan-3' });
    await chooseMode({ item: w.item(), mode: 'ai' }, w.deps);
    assert.deepStrictEqual([w.row.planAutomationId, w.row.planId, w.row.setup_state], [null, null, 'ai']);
    await chooseMode({ item: w.item(), mode: 'steps' }, w.deps);
    assert.deepStrictEqual([w.row.planAutomationId, w.row.planId, w.row.setup_state], ['auto-1', 'plan-3', null]);
    assert.deepStrictEqual(w.row.record, {}, 'nothing is left behind');
});

test('there is nothing to undo for a task that was not switched from its steps, or that has steps again', async () => {
    const never = world();
    await assert.rejects(chooseMode({ item: never.item(), mode: 'steps' }, never.deps), (/** @type {any} */ e) => e.status === 409 && e.code === 'cowork_setup_refused');

    const again = world({ planAutomationId: 'auto-1' });
    await chooseMode({ item: again.item(), mode: 'ai' }, again.deps);
    again.row.planAutomationId = 'auto-2';
    await assert.rejects(chooseMode({ item: again.item(), mode: 'steps' }, again.deps), /steps again already/);
});
