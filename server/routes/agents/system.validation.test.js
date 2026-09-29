'use strict';

/**
 * What the system-agent helpers accept, and what they say when they refuse
 * (routes/agents/system.js).
 *
 * Each helper builds its prompt straight out of the body, and every field it
 * cannot find becomes "(not set)" or "(empty)" INSIDE that prompt. So a
 * misspelled `sytemPrompt` on the description improver produced a confident
 * description of an agent the model had been told nothing about, answered
 * 200 — and a body that was not sent at all threw on the destructure and
 * came back a 500 with a correlation id and no field name.
 *
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.systemPrompt`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - no model is called, so a refused request costs nothing.
 *
 * Run: cd server && node --test routes/agents/system.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Every model call lands in `touched`. A refused request must leave it empty.
const touched = [];

mock(path.join(SERVER, 'stores/agentStore'), {
    getSystemAgent: async (id) => ({ id, system_prompt: 'you are a helper' }),
    getSystemAgents: async () => [],
});
mock(path.join(SERVER, 'core/llm/llmClient'), {
    chat: async (model, messages, opts) => { touched.push({ what: 'chat', args: [model, messages, opts] }); return { content: '["a","b"]' }; },
    stream: async () => {},
});
mock(path.join(SERVER, 'core/llm/modelResolver'), {
    resolveModelWithGlobalFallback: async () => 'fast-model',
    getTierConfig: async () => ({ modelId: 'fast-model', maxTokens: 100 }),
});
mock(path.join(SERVER, 'core/aiAgent'), { getProviderForModel: async () => ({}), getAIConfig: async () => ({}) });
mock(path.join(SERVER, 'auth'), {
    requireAuth: (req, res, next) => next(),
    requirePermission: () => (req, res, next) => next(),
    resolveUserOrgIds: async () => new Set(['org1']),
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });

const router = require('./system');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'me' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            set() { return this; }, setHeader() {}, flushHeaders() {}, write() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: POST ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `POST ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'and no model is called');
    return res;
}

test('a misspelled prompt key is refused, not written into the prompt as "(empty)"', async () => {
    await refuses({
        url: '/system/description-improver/generate',
        body: { agentName: 'Invoices', sytemPrompt: 'you handle invoices' },
    }, 'body');
});

test('a missing system prompt is still refused, now by name', async () => {
    const res = await refuses({
        url: '/system/identity-improver/generate',
        body: { currentName: 'Invoices' },
    }, 'body.systemPrompt');
    assert.strictEqual(res.body.error, 'System prompt is required to generate identity');
});

test('a prompt that is not text is refused by name, not called missing', async () => {
    await refuses({ url: '/system/identity-improver/generate', body: { systemPrompt: 42 } }, 'body.systemPrompt');
});

test('no body at all is a 400 that names the field, not a 500 on the destructure', async () => {
    const res = await refuses({ url: '/system/prompt-designer/stream', body: undefined }, 'body.message');
    assert.strictEqual(res.body.error, 'Message is required');
});

test('the fields the editor sends still reach the model', async () => {
    const res = await dispatch({
        url: '/system/conversation-starters/generate',
        body: { agentName: 'Invoices', agentDescription: 'handles invoices', systemPrompt: 'be brief' },
    });
    assert.strictEqual(res.statusCode, 200);
    const [, messages] = touched.find((t) => t.what === 'chat').args;
    assert.match(messages[1].content, /Invoices/);
    assert.match(messages[1].content, /be brief/);
});
