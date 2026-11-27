/**
 * The mid-loop skill activation handler: a chat turn records nothing and the handler still answers. What a Cowork run
 * records is the cowork module's: ./skillActivation.cowork.test.js. The handler is built by ./skillActivation.testkit.js.
 *
 * Run: node --test core/agentRuntime/chatStream/skillActivation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { handlerFor } = require('./skillActivation.testkit');

test('a chat turn has no run context and the handler still answers', async () => {
    const res = await handlerFor({})(['s1']);
    assert.deepStrictEqual(res, { addedTools: [], unavailableApps: [] });
});
