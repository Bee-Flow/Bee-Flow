/**
 * What the Nextcloud Task Processing endpoint accepts from the connector, and
 * what it refuses (routes/nextcloudTaskProcessing.js).
 *
 * Two findings are pinned here:
 *
 *   - A text task with no text (`input: {}`, or the text under another key)
 *     reached the model as an empty message, and its answer came back 200 as
 *     the result of that person's task. A text task now needs `input.input`.
 *   - Agent threads were keyed by `conversation_token` alone, and that token
 *     is task input any Nextcloud user can set. Someone else's token now
 *     starts a fresh conversation instead of continuing theirs.
 *
 * And the order: the signature is checked before the schema, so an unsigned
 * caller hears 401 and learns nothing about the shape.
 *
 * Run: cd server && node --test routes/nextcloudTaskProcessing.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

const llmCalls = [];

const MOCKS = {
    '../auth/connectorSig': {
        // A request "signed" by the test names its org in a header.
        verifyConnectorSig: async (req) => (req.headers['x-test-org'] ? { id: req.headers['x-test-org'] } : null),
    },
    '../stores/userStore': {
        getUserByNcUid: async (orgId, ncUid) => ({ id: `bf-${orgId}-${ncUid}` }),
    },
    '../core/llm/modelResolver': { resolveModelWithGlobalFallback: async () => 'model-1' },
    '../core/llm/llmClient': {
        async chat(modelId, messages) {
            llmCalls.push(messages.map((m) => ({ role: m.role, content: m.content })));
            return { content: 'the answer' };
        },
    },
    '../core/integrations/integrationTools': { getIntegrationTools: async () => ({ tools: [] }) },
    '../core/tools/toolDispatcher': { executeTool: async () => null },
    '../automation/sideEffectMap': { isSideEffect: () => false },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:nc-task-processing-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]nextcloudTaskProcessing\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./nextcloudTaskProcessing');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use('/api/nextcloud/task-processing', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/nextcloud/task-processing`;
});

test.after(async () => {
    Module._resolveFilename = originalResolve;
    await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => { llmCalls.length = 0; });

async function execute(body, { org = 'org-1' } = {}) {
    const res = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(org ? { 'x-test-org': org } : {}) },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

const refusedAt = (r, path) => r.status === 400 && r.json.details.some((d) => d.path === path);

test('an unsigned request is 401 before any schema speaks', async () => {
    const r = await execute({ nonsense: true }, { org: null });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.details, undefined, 'no shape is revealed to an unsigned caller');
});

test('a text task with no text is refused, not answered with a summary of nothing', async () => {
    const r = await execute({ taskType: 'core:text2text:summary', input: {}, ncUid: 'alice' });
    assert.ok(refusedAt(r, 'body.input.input'), JSON.stringify(r.json));
    assert.strictEqual(r.json.error, 'A text task needs input.input: the text to work on.');
    assert.deepStrictEqual(llmCalls, [], 'the model is never asked');
});

test('a text under another key is refused the same way', async () => {
    const r = await execute({ taskType: 'core:text2text:summary', input: { text: 'Lange mail over de offerte.' } });
    assert.ok(refusedAt(r, 'body.input.input'));
    assert.deepStrictEqual(llmCalls, []);
});

test('an empty input from PHP ([]) is an empty object, so a text task still hears why', async () => {
    const r = await execute({ taskType: 'core:text2text:headline', input: [] });
    assert.ok(refusedAt(r, 'body.input.input'));
});

test('a text task with its text reaches the model and answers', async () => {
    const r = await execute({
        taskType: 'core:text2text:summary', input: { input: 'Lange mail over de offerte.' }, ncUid: 'alice',
        customId: null, appId: 'mail',
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { output: { output: 'the answer' } });
    assert.strictEqual(llmCalls[0].at(-1).content, 'Lange mail over de offerte.');
});

test('a missing taskType is refused in words', async () => {
    const r = await execute({ input: { input: 'x' } });
    assert.ok(refusedAt(r, 'body.taskType'));
    assert.strictEqual(r.json.error, 'taskType names the Nextcloud task type, like core:text2text:summary.');
});

test('a key a newer connector adds is dropped, not refused: the top level is not strict', async () => {
    const r = await execute({ taskType: 'core:text2text', input: { input: 'hoi' }, priority: 'high' });
    assert.strictEqual(r.status, 200);
});

test('an input that is not an object is refused', async () => {
    const r = await execute({ taskType: 'core:text2text', input: 'hoi' });
    assert.ok(refusedAt(r, 'body.input'));
});

// ── Agent threads belong to whoever started them ────────────────────

const AGENT = 'core:contextagent:interaction';

test('someone else\'s conversation_token starts a fresh conversation, not theirs', async () => {
    const first = await execute({ taskType: AGENT, input: { input: 'Wat staat er morgen in mijn agenda?' }, ncUid: 'alice' });
    assert.strictEqual(first.status, 200);
    const token = first.json.output.conversation_token;

    llmCalls.length = 0;
    const other = await execute({ taskType: AGENT, input: { input: 'Ga verder', conversation_token: token }, ncUid: 'bob' });
    assert.strictEqual(other.status, 200);
    const seen = JSON.stringify(llmCalls[0]);
    assert.ok(!seen.includes('agenda'), 'bob\'s turn must not carry alice\'s messages');
    assert.notStrictEqual(other.json.output.conversation_token, token, 'bob gets a token of his own');

    llmCalls.length = 0;
    const again = await execute({ taskType: AGENT, input: { input: 'En overmorgen?', conversation_token: token }, ncUid: 'alice' });
    assert.strictEqual(again.json.output.conversation_token, token);
    assert.ok(JSON.stringify(llmCalls[0]).includes('agenda'), 'alice still continues her own thread');
});

test('the same user in another organisation does not share a thread either', async () => {
    const first = await execute({ taskType: AGENT, input: { input: 'Mijn salarisstrook' }, ncUid: 'alice' }, { org: 'org-1' });
    const token = first.json.output.conversation_token;
    llmCalls.length = 0;
    await execute({ taskType: AGENT, input: { input: 'verder', conversation_token: token }, ncUid: 'alice' }, { org: 'org-2' });
    assert.ok(!JSON.stringify(llmCalls[0]).includes('salarisstrook'));
});

test('an agent turn with an empty input from PHP still runs: the text rule is for text tasks', async () => {
    const r = await execute({ taskType: AGENT, input: [], ncUid: 'alice' });
    assert.strictEqual(r.status, 200);
});
