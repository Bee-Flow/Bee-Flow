// @typecheck
/**
 * Shared set-up of the Cowork tests that run on the REAL automation engine (*.engine.pg.test.js): the Cowork store on
 * PGlite behind db.js, the runner ports boot registers (the runner reaches the features through them), and waiting
 * for a try-out of an item's plan to be over.
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

module.exports = { coworkOnEngine, triedOut };
