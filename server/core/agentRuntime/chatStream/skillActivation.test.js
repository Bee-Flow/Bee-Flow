/**
 * The mid-loop skill activation handler: a Cowork run records which skills the model activated, also when the
 * activation widens no tools (external tools off), and a chat turn records nothing.
 *
 * Run: node --test core/agentRuntime/chatStream/skillActivation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createSkillActivationHandler } = require('./skillActivation');
const { createRunActivity } = require('../../cowork/runActivity.mts');

const handlerFor = (messageMetadata) => createSkillActivationHandler(/** @type {any} */ ({
    agent: { id: 'a1', config: {} }, agentId: 'a1', userId: 'u1', userAuth: {}, messageMetadata, onEvent: () => {},
    conversation: { id: 'c1' }, isEphemeral: true, tools: [], disableExternalTools: true,
    skillApps: { allowedApps: [], dynamicSkillApps: new Map(), mergedIds: [] }, activatedSkillIds: [], baseIntegrationToolNames: new Set(),
}));

test('a Cowork run notes the skills the model activated', async () => {
    const coworkRun = createRunActivity();
    await handlerFor({ coworkRun })(['s1', 's2']);
    assert.deepStrictEqual([...coworkRun.activatedSkills], ['s1', 's2']);
});

test('a chat turn has no run context and the handler still answers', async () => {
    const res = await handlerFor({})(['s1']);
    assert.deepStrictEqual(res, { addedTools: [], unavailableApps: [] });
});
