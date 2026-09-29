/**
 * What POST /api/studio/ai/route accepts, and what it says when it refuses
 * (routes/studio/aiRoute.js).
 *
 * `String(req.body.text)` used to make a request out of anything: an object
 * reached the model as the words "[object Object]" — a real fast-tier call and
 * a usage row for a sentence nobody wrote — and a `kind` meant to steer the
 * answer was dropped under a 200. What this file pins:
 *
 *   - the 400 NAMES the field (`body.text`), in a sentence;
 *   - no model call and no usage row for a refused body;
 *   - the session is still checked first (401 before 400);
 *   - the two answers the client depends on are unchanged: blank text is 400
 *     `no_text`, and long text is clamped rather than refused.
 *
 * Run: cd server && node --test routes/studio/aiRoute.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { createAiRouteRouter, MAX_TEXT_CHARS } = require('./aiRoute');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

// Every model call and usage row lands here. A refused body must leave both empty.
const calls = { chat: [], usage: [] };
const deps = {
    modules: { isModuleActive: async () => true },
    license: { featureAllowedForRequest: async () => ({ allowed: true, resolution: {} }) },
    entitlements: { hasCapability: async () => true },
    permissions: { hasPermission: async () => true },
    configStore: { getConfig: async () => null },
    modelResolver: { resolveModelForTier: async () => 'fast-1', resolveModelWithGlobalFallback: async () => 'fast-2' },
    llmClient: {
        chatForcedTool: async (modelId, messages) => {
            calls.chat.push(messages);
            return { structured: { kind: 'automation', name: 'Reminder', seed: 'Send a reminder.' }, usage: {} };
        },
    },
    usageStore: { logUsage: async (row) => { calls.usage.push(row); } },
};

let server;
let baseUrl;
test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = req.headers['x-test-user']
            ? { isAuthenticated: true, user: { id: req.headers['x-test-user'], organizationId: 'orgA' } }
            : {};
        next();
    });
    app.use('/api/studio', createAiRouteRouter(deps));
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { calls.chat.length = 0; calls.usage.length = 0; });

async function post(body, user = 'u1') {
    const res = await fetch(`${baseUrl}/api/studio/ai/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

async function refuses(body, field) {
    const res = await post(body);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field), `the 400 must name ${field}: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(calls.chat, [], 'a refused body must not reach the model');
    assert.deepStrictEqual(calls.usage, [], 'and must not write a usage row');
    return res;
}

test('text that is not text is refused by name, instead of reaching the model as "[object Object]"', async () => {
    for (const text of [{ goal: 'invoices' }, ['plan my invoices'], 42, true]) {
        const res = await refuses({ text }, 'body.text');
        assert.strictEqual(res.body.error, 'text is the description of what to build, as one piece of text.', JSON.stringify(text));
    }
});

test('a key the route never read is refused, not dropped under a 200', async () => {
    const res = await refuses({ text: 'an app for leave requests', kind: 'agent' }, 'body');
    assert.match(res.body.error, /"kind"/);
});

test('a body that is not an object is refused in a sentence', async () => {
    const res = await refuses([], 'body');
    assert.strictEqual(res.body.error, 'The body is a JSON object: { "text": "…" }.');
});

test('the session is still checked before the body', async () => {
    const res = await post({ text: 42 }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(calls.chat, []);
});

test('blank text keeps its own code, which is the one the client maps', async () => {
    for (const body of [{}, { text: null }, { text: '   ' }]) {
        const res = await post(body);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'no_text', JSON.stringify(body));
    }
    assert.deepStrictEqual(calls.chat, []);
});

test('long text is still clamped rather than refused, and a well-formed body is answered', async () => {
    const res = await post({ text: 'x'.repeat(MAX_TEXT_CHARS + 10) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.kind, 'automation');
    assert.strictEqual(calls.chat.length, 1);
    assert.ok(!JSON.stringify(calls.chat[0]).includes('x'.repeat(MAX_TEXT_CHARS + 1)));
});
