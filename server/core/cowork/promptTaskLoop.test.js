// @typecheck
/**
 * The tool loop of a plain-prompt Cowork run (./promptTaskLoop.js) under the run's signal (./runDeadline.mts): the
 * model call gets the signal, and once it aborted no further model round and no further tool call starts.
 *
 * Everything the loop touches is handed in, so nothing is mocked.
 *
 * Run: cd server && node --test core/cowork/promptTaskLoop.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { runPromptToolLoop } = require('./promptTaskLoop');
const { createUsageAccumulator } = require('../providers/usageNormalizer');

const noGate = { refuse: async () => null, forModel: async (text) => text };
const toolCall = (name, id = name) => ({ id, function: { name, arguments: '{}' } });

function loopOpts(over) {
    return {
        config: { apiKey: 'k', url: 'http://stub' }, modelId: 'model-x', messages: [{ role: 'user', content: 'Do it.' }],
        tools: [{ type: 'function', function: { name: 'outlook_search' } }], tierDefaults: {}, usageAcc: createUsageAccumulator(),
        shieldGate: /** @type {any} */ (noGate), logTermination: () => {}, run: {}, ...over,
    };
}

test('without a signal the loop runs as before: tool round, then the answer', async () => {
    const dispatched = [];
    const replies = [{ content: null, toolCalls: [toolCall('outlook_search')] }, { content: 'Three new mails.' }];
    const out = await runPromptToolLoop(loopOpts({
        adapter: { chat: async () => replies.shift() },
        dispatchTool: async (name) => { dispatched.push(name); return 'ok'; },
    }));
    assert.strictEqual(out.finalResponse, 'Three new mails.');
    assert.deepStrictEqual(dispatched, ['outlook_search']);
});

test('the model call is given the run\'s signal, so the adapter can cancel the call in flight', async () => {
    const controller = new AbortController();
    const seen = [];
    await runPromptToolLoop(loopOpts({
        signal: controller.signal,
        adapter: { chat: async (apiKey, url, model, messages, options) => { seen.push(options.signal); return { content: 'Done.' }; } },
        dispatchTool: async () => 'ok',
    }));
    assert.deepStrictEqual(seen, [controller.signal]);
});

test('a signal that already aborted starts no model round at all, and the loop fails with its reason', async () => {
    const controller = new AbortController();
    const reason = new Error('This run was stopped after 20 minutes: it took longer than a run may take.');
    controller.abort(reason);
    let calls = 0;
    await assert.rejects(
        runPromptToolLoop(loopOpts({ signal: controller.signal, adapter: { chat: async () => { calls += 1; return { content: 'Done.' }; } }, dispatchTool: async () => 'ok' })),
        (err) => err === reason,
    );
    assert.strictEqual(calls, 0);
});

test('an abort during a tool round stops the remaining tool calls and the next model round', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped');
    const dispatched = [];
    let rounds = 0;
    await assert.rejects(
        runPromptToolLoop(loopOpts({
            signal: controller.signal,
            adapter: { chat: async () => { rounds += 1; return { content: null, toolCalls: [toolCall('outlook_search', 'a'), toolCall('outlook_read', 'b'), toolCall('outlook_send', 'c')] }; } },
            dispatchTool: async (name) => { dispatched.push(name); if (name === 'outlook_search') controller.abort(reason); return 'ok'; },
        })),
        (err) => err === reason,
    );
    assert.deepStrictEqual(dispatched, ['outlook_search'], 'the call in flight finished; the next two never started');
    assert.strictEqual(rounds, 1);
});

test('an abort without an Error as its reason still stops the loop with an error', async () => {
    const controller = new AbortController();
    controller.abort('because');
    await assert.rejects(
        runPromptToolLoop(loopOpts({ signal: controller.signal, adapter: { chat: async () => ({ content: 'Done.' }) }, dispatchTool: async () => 'ok' })),
        /The run was stopped/,
    );
});
