/**
 * What the AI regex generator accepts (routes/ai/config/regexGenerator.js).
 *
 * A tier the caller named was looked up as `tiers[modelTier] || {}` and then
 * swapped for the global default model — so a tier that is not configured
 * generated the org's guardrail rules on whatever model happened to be the
 * default, answered "generated". A named tier is now honoured or refused.
 * Sending none still means fast, then the default: the page does that while
 * its tier list is empty.
 *
 * Run: cd server && node --test routes/ai/config/regexGenerator.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// The first thing past the checks is the agent lookup; it lands in `reached`.
const reached = [];
const fx = { isAdmin: true, tiers: { fast: { modelId: 'm-fast' }, writer: { modelId: '' } } };

const MOCKS = {
    '../../../core/aiAgent': {
        getAIConfig: async () => ({ model: 'm-default' }),
        getProviderForModel: async () => ({ url: 'http://llm.invalid/v1' }),
    },
    '../../../stores/configStore': { getConfig: async (key) => (key === 'chat_model_tiers' ? fx.tiers : null) },
    './shared': { isAdminUser: async () => fx.isAdmin },
    '../../../auth/permissions': { requireAuth: (req, res, next) => next() },
    // Returning no agent ends the request right after the checks under test,
    // without a model call.
    '../../../stores/agentStore': {
        REGEX_GENERATOR_AGENT_ID: 'system-regex-generator',
        getAgent: async (id) => { reached.push(id); return null; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:regex-generator-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /config[\\/]regexGenerator\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./regexGenerator');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch(body) {
    const url = '/generate-regex';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { reached.length = 0; fx.isAdmin = true; });

test('a tier that is not configured is refused instead of swapped for the default model', async () => {
    const res = await dispatch({ prompt: 'Dutch IBANs', modelTier: 'thinkng' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'tier_not_configured');
    assert.match(res.body.error, /'thinkng' has no model configured/);
    assert.deepStrictEqual(reached, [], 'no generation started');
});

test('a tier that exists but has no model is refused the same way', async () => {
    const res = await dispatch({ prompt: 'Dutch IBANs', modelTier: 'writer' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'tier_not_configured');
    assert.deepStrictEqual(reached, []);
});

test('a configured tier gets past the check', async () => {
    const res = await dispatch({ prompt: 'Dutch IBANs', modelTier: 'fast' });
    assert.deepStrictEqual(reached, ['system-regex-generator']);
    assert.strictEqual(res.statusCode, 500, 'the (mocked) missing agent ends it after the checks');
});

test('no tier still means fast, then the default — the page sends that while its list is empty', async () => {
    await dispatch({ prompt: 'Dutch IBANs', modelTier: '' });
    assert.deepStrictEqual(reached, ['system-regex-generator']);
});

test('a prompt that is not text is refused by name, not a TypeError on .trim()', async () => {
    const res = await dispatch({ prompt: 42 });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Prompt is required');
    assert.ok(res.body.details.some((d) => d.path === 'body.prompt'));
    assert.deepStrictEqual(reached, []);
});

test('a misspelled field is refused rather than ignored', async () => {
    const res = await dispatch({ prompt: 'Dutch IBANs', tier: 'fast' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(reached, []);
});

test('a non-admin gets the 403 before the schema says anything', async () => {
    fx.isAdmin = false;
    const res = await dispatch({ nonsense: true });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Admin access required' });
});
