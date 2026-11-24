// @typecheck
/**
 * Shared set-up of the Cowork tests that run on the REAL automation engine (*.engine.pg.test.js): the Cowork store on
 * PGlite behind db.js, the runner ports boot registers (the runner reaches the features through them), waiting
 * for a try-out of an item's plan to be over, and an item run until it waits at its question before a mail.
 */

'use strict';

const assert = require('node:assert');

/**
 * The stores on PGlite, with the runner ports registered. Call once, at the top of a test file, before the engine.
 * @returns {ReturnType<typeof import('../../stores/coworkStore.testkit').coworkStoreOnPglite>}
 */
function coworkOnEngine() {
    const world = require('../../stores/coworkStore.testkit').coworkStoreOnPglite();
    // What boot registers for the server: the runner reaches these features through its ports.
    require('../../automation/runnerPorts');
    require('../../integrations/runnerPorts');
    require('../../services/runnerPorts');
    require('./runnerPorts'); // Cowork's own: a plan's journey keeps its approved copy across a pause
    return world;
}

/**
 * Try the item's plan and wait until the try-out is over; it must have ended well.
 * @param {Parameters<typeof import('../../usecases/coworkPlanTry.mts').startTry>[0]['item']} item
 * @returns {Promise<string>} the try-out's id
 */
async function triedOut(item) {
    const { startTry, tryStateOf } = require('../../usecases/coworkPlanTry.mts');
    const { tryId } = await startTry({ item });
    let state = await tryStateOf({ item, tryId });
    for (let i = 0; i < 100 && !state.done; i++) {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        state = await tryStateOf({ item, tryId });
    }
    assert.strictEqual(state.status, 'success', `the try-out finished (${state.error})`);
    return tryId;
}

/**
 * An item of `owner` with `definition` as its approved plan, asking before it sends, run until it waits at the
 * question in front of the step `send`: the item, the question and the automation run.
 * @param {ReturnType<typeof coworkOnEngine>['store']} store the Cowork store of coworkOnEngine()
 * @param {{ owner: string, title: string, definition: Record<string, unknown> }} spec
 */
async function waitingQuestion(store, { owner, title, definition }) {
    const automationStore = require('../../stores/automationStore');
    const { executeTask } = require('../aiTaskRunner');
    const { attachPlan, approvePlan } = require('../../usecases/coworkPlan.mts');
    const { chooseIndependence } = require('../../usecases/coworkIndependence.mts');
    const automation = await automationStore.createAutomation({ userId: owner, title, definition, triggerType: 'manual' });
    const created = await store.createSchedule({ userId: owner, title, prompt: 'Tell me.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const attached = await attachPlan({ item: await store.getSchedule(created.id), automationId: automation.id });
    await approvePlan({ item: await store.getSchedule(created.id), fingerprint: attached.draft.fingerprint });
    await chooseIndependence({ item: await store.getSchedule(created.id), level: 'asks_before_sending' });
    await executeTask(await store.getSchedule(created.id), { manual: true, store });
    const [waiting] = await store.listRuns(created.id);
    assert.strictEqual(waiting.status, 'waiting', `the run waits before the mail (${waiting.error})`);
    const link = await store.getPlanRun(created.id, waiting.id);
    const approval = await automationStore.getApprovalForRunStep(link.automationRunId, 'cowork_ask__send', { pendingOnly: true });
    assert.ok(approval, 'the question is there to decide');
    return { itemId: created.id, approval, run: await automationStore.getRun(link.automationRunId) };
}

module.exports = { coworkOnEngine, triedOut, waitingQuestion };
