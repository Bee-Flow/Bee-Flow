/**
 * The anonymous public-share AI bridge spends the AUTHOR's model budget on
 * behalf of whoever holds the page's bearer token — and that token sits in the
 * page source, so every visitor can post any body they like
 * (routes/publicShareBridge.js).
 *
 * clampBody bounds the prompt, the messages and their total length. The one
 * part it did not count was `schema`, which goes to the model as a tool
 * definition: `{"prompt":"hi","schema":{"description":"<megabytes>"}}` passed
 * every clamp and reached the author's model whole. What this file pins:
 *
 *   - an oversized schema is a 400 with a sentence, and no model call is made;
 *   - a real output schema, and the open `opts` bag a page passes (`tier`
 *     included — ignored here on purpose), still work;
 *   - a call with nothing to answer is a 400 on both routes, before a stream
 *     opens — it was a bare 500 on /ai/chat and an unread SSE error on
 *     /ai/stream, where the page's stream() resolved with an empty string.
 *
 * Run: cd server && node --test routes/publicShareBridge.clamp.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every model call lands in `calls`. A clamped request must leave it empty.
const calls = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../auth/publicShareToken': { verifyBridgeToken: () => ({ shareId: 's1', webpageId: 'wp1' }) },
    '../stores/webpagePublicShareStore': { getShareById: async () => ({ id: 's1', webpageId: 'wp1' }) },
    '../stores/webpageStore': {
        getBridgeGrants: async () => ({ ai: { publicEnabled: true, publicDefaultTier: 'fast' } }),
    },
    '../core/webpages/webpageBridgeAuth': {
        loadAuthorContext: async () => ({ authorUserId: 'author', authorOrgId: 'org1', webpage: { name: 'Page' } }),
    },
    '../core/webpages/webpageAiMessages': {
        // The real one's first line: nothing to answer is a throw.
        buildAiMessages: async (ctx, body) => {
            const messages = Array.isArray(body.messages) ? body.messages : [];
            if (!body.prompt && messages.length === 0) throw new Error('prompt or messages is required');
            return [...messages, ...(body.prompt ? [{ role: 'user', content: String(body.prompt) }] : [])];
        },
    },
    '../core/llm/llmClient': {
        chat: async (modelId, messages, opts) => {
            calls.push({ modelId, opts });
            return { toolCalls: [{ function: { name: 'return_structured_output', arguments: '{"ok":true}' } }], usage: {} };
        },
        forcedToolChoiceFor: async () => 'required',
        stream: async () => {},
    },
    '../core/llm/modelResolver': {
        resolveModelForTier: async (tier) => { calls.push({ tier }); return { modelId: 'm-fast' }; },
        TIER_DEFAULTS: { fast: { maxTokens: 1024, temperature: 0.2 } },
    },
    '../stores/usageStore': {
        getUsageSummary: async () => ({ total_estimated_cost: 0 }),
        logUsage: async () => {},
    },
    '../core/http/sseHelpers': { startSseHeartbeat: () => () => {} },
    './publicShareBridgeRateLimits': { publicAiLimiter: pass, publicIpLimiter: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:public-share-bridge-clamp:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]publicShareBridge\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./publicShareBridge');
test.after(() => { Module._resolveFilename = originalResolve; });

function post(url, body) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {},
            headers: { authorization: 'Bearer t' }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            // The SSE route: a stream that opened is visible as `stream`.
            writeHead(c) { this.statusCode = c; this.headersSent = true; this.stream = ''; return this; },
            write(chunk) { this.stream += chunk; return true; },
            on() {},
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: POST ${url}`)));
    });
}

const chat = (body) => post('/ai/chat', body);

test.beforeEach(() => { calls.length = 0; });

test('an oversized output schema is refused before the author\'s model is called', async () => {
    const schema = { type: 'object', description: 'x'.repeat(50_000) };
    const res = await chat({ prompt: 'hi', schema });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Output schema is too large.');
    assert.deepStrictEqual(calls, [], 'no tier resolution and no model call for a clamped body');
});

test('a real output schema still gets its structured answer', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean', description: 'Did it work?' } }, required: ['ok'] };
    const res = await chat({ prompt: 'hi', schema });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { json: { ok: true } });
    assert.strictEqual(calls.filter((c) => c.modelId).length, 1);
});

test('the open opts bag a page passes still works, and a viewer-supplied tier is still ignored', async () => {
    const res = await chat({ prompt: 'hi', schema: { type: 'object' }, tier: 'smart', maxTokens: 100 });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls.find((c) => c.tier).tier, 'tier:fast');
    assert.strictEqual(calls.find((c) => c.modelId).opts.maxTokens, 100);
});

test('a call with nothing to answer is a 400 in words on /ai/chat — it was a bare 500', async () => {
    const res = await chat({});
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A prompt is required: the text to answer, or a list of messages.');
    assert.deepStrictEqual(calls, [], 'no tier resolution and no model call');
});

test('on /ai/stream it is the same 400, before any stream opens — the page\'s stream() never read the error event', async () => {
    for (const body of [{}, { prompt: '' }, { prompt: '', messages: [] }]) {
        const res = await post('/ai/stream', body);
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
        assert.strictEqual(res.stream, undefined, 'no SSE was opened');
        assert.match(res.body.error, /^A prompt is required/);
    }
    assert.deepStrictEqual(calls, []);
});

test('a conversation without a separate prompt still gets its answer', async () => {
    const res = await chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls.filter((c) => c.modelId).length, 1);
});
