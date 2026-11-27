/**
 * The mid-loop skill activation handler (./skillActivation.js) in a Cowork run: the run records which skills the model
 * activated, also when the activation widens no tools (external tools off). Moved out of ./skillActivation.test.js
 * unchanged; it belongs to the cowork module.
 *
 * Run: node --test core/agentRuntime/chatStream/skillActivation.cowork.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { handlerFor } = require('./skillActivation.testkit');
const { createRunActivity } = require('../../cowork/runActivity.mts');

test('a Cowork run notes the skills the model activated', async () => {
    const coworkRun = createRunActivity();
    await handlerFor({ coworkRun })(['s1', 's2']);
    assert.deepStrictEqual([...coworkRun.activatedSkills], ['s1', 's2']);
});
