/**
 * The planner's model call (./coworkPlannerChat.mts): tried again when the provider was briefly unavailable, and only
 * then. The model call and the wait are handed in, so nothing is mocked and nothing sleeps.
 *
 * Run: cd server && node --test usecases/coworkPlannerChat.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { plannerChat, PLANNER_CHAT_TRIES } = require('./coworkPlannerChat.mts');
const { isTransientChatError } = require('./ai/builderShared');

const busy = () => Object.assign(new Error('overloaded'), { status: 529 });

function scripted(answers) {
    const seen = { calls: 0, waits: [] };
    const deps = {
        chat: async () => { const next = answers[seen.calls++]; if (next instanceof Error) throw next; return next; },
        isTransient: isTransientChatError,
        wait: async (ms) => { seen.waits.push(ms); },
    };
    return { seen, deps };
}

test('an answer is an answer: one call, no wait', async () => {
    const { seen, deps } = scripted([{ content: 'Done.' }]);
    assert.deepStrictEqual(await plannerChat('m', [], {}, deps), { content: 'Done.' });
    assert.deepStrictEqual([seen.calls, seen.waits], [1, []]);
});

test('a provider that was briefly unavailable is asked again, a little later each time', async () => {
    const { seen, deps } = scripted([busy(), Object.assign(new Error('rate limit'), { status: 429 }), { content: 'Done.' }]);
    assert.deepStrictEqual(await plannerChat('m', [], {}, deps), { content: 'Done.' });
    assert.deepStrictEqual([seen.calls, seen.waits], [3, [500, 1000]]);
});

test('it gives up after its tries, with the provider\'s own error', async () => {
    const { seen, deps } = scripted(Array(10).fill(busy()));
    await assert.rejects(plannerChat('m', [], {}, deps), /overloaded/);
    assert.strictEqual(seen.calls, PLANNER_CHAT_TRIES);
});

test('an error that asking again cannot fix is not asked again', async () => {
    const { seen, deps } = scripted([Object.assign(new Error('invalid request: tools[0] has no name'), { status: 400 }), { content: 'never' }]);
    await assert.rejects(plannerChat('m', [], {}, deps), /invalid request/);
    assert.deepStrictEqual([seen.calls, seen.waits], [1, []]);
});

test('a request that was stopped is not asked again, whatever the error looks like', async () => {
    const stop = new AbortController();
    const { seen, deps } = scripted([busy(), { content: 'never' }]);
    stop.abort();
    await assert.rejects(plannerChat('m', [], { signal: stop.signal }, deps), /overloaded/);
    assert.strictEqual(seen.calls, 1);
});
