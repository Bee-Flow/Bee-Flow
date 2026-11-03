/**
 * The per-call deadline on App Studio model calls, through the real aiRuntime and a stubbed
 * llmClient: a model call that never answers is aborted (the signal fired), retried once, and
 * then the step fails with the safe message; the next call is untouched by the first.
 *
 * Run: node --test appStudio/aiRuntime.timeout.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const calls = [];
const behaviour = { mode: 'hang' };
// Replace the functions on the real modules before aiRuntime reads them (no module mocking).
Object.assign(require('../core/llm/llmClient'), {
    chat: async (_model, _messages, options) => {
        calls.push(options);
        if (behaviour.mode === 'hang' || (behaviour.mode === 'retry-ok' && calls.length === 1)) return new Promise(() => {});
        return { content: 'a summary', usage: {} };
    },
});
Object.assign(require('../stores/usageStore'), { logUsage: async () => {} });

const aiRuntime = require('./aiRuntime');

const APP = { id: 'app1', userId: 'owner1', organizationId: 'org1' };
const MODEL = { modelId: 'm-std', options: {} };

test('a model call that never answers: one retry, the signal fired, the safe error', async () => {
    process.env.STUDIO_AI_CALL_TIMEOUT_MS = '50';
    try {
        calls.length = 0;
        behaviour.mode = 'hang';
        await assert.rejects(
            aiRuntime.runText(APP, MODEL, { system: '', user: 'x' }),
            (e) => e.code === 'ai_timeout' && e.safe === true && /^The AI gave no answer within \d+ s$/.test(e.message),
        );
        assert.strictEqual(calls.length, 2, 'the first attempt and exactly one retry');
        assert.ok(calls.every((o) => o.signal && o.signal.aborted), 'every attempt was aborted');
    } finally { delete process.env.STUDIO_AI_CALL_TIMEOUT_MS; }
});

test('a model that answers on the retry gives the answer', async () => {
    process.env.STUDIO_AI_CALL_TIMEOUT_MS = '50';
    try {
        calls.length = 0;
        behaviour.mode = 'retry-ok';
        const out = await aiRuntime.runText(APP, MODEL, { system: '', user: 'x' });
        assert.strictEqual(out.text, 'a summary');
        assert.strictEqual(calls.length, 2);
    } finally { delete process.env.STUDIO_AI_CALL_TIMEOUT_MS; }
});

test('STUDIO_AI_CALL_TIMEOUT_MS=0: no signal is passed at all', async () => {
    process.env.STUDIO_AI_CALL_TIMEOUT_MS = '0';
    try {
        calls.length = 0;
        behaviour.mode = 'ok';
        await aiRuntime.runText(APP, MODEL, { system: '', user: 'x' });
        assert.strictEqual(calls[0].signal, undefined);
    } finally { delete process.env.STUDIO_AI_CALL_TIMEOUT_MS; }
});
