/**
 * Who may rewrite the chat model tiers (routes/ai/config/modelTiers.js).
 *
 * `chat_model_tiers` and `chat_model_tiers_eu` are instance-wide: every chat,
 * agent and routine on the install resolves "tier:fast", "tier:thinking" … to
 * the model named there, and the EU set is what an org with "EU only" switched
 * on is routed to. Every other write in this file checked isAdminUser; these
 * two only checked requireAuth, so any signed-in member could point the whole
 * install at a model of their choosing — including, for the EU set, one that
 * does not process in the EU. Found by validation batch 2a, outside its
 * territory.
 *
 * The reads stay open on purpose: the tier pickers every member sees read them.
 *
 * Run: cd server && node --test routes/ai/config/modelTiers.authz.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const writes = [];
const fx = { admin: false };

const MOCKS = {
    '../../../stores/configStore': {
        getConfig: async () => null,
        setConfig: async (key, value) => { writes.push([key, value]); },
    },
    './shared': { isAdminUser: async () => fx.admin },
    '../../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Not authenticated' })),
    },
    '../../../core/aiAgent': { getProviderForModel: async () => ({ providerType: 'claude', url: '' }) },
    '../../../core/llm/promptClassifier': { clearClassifierCache: () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:model-tiers-authz:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /config[\\/]modelTiers\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./modelTiers');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body, headers: {}, session: { user: { id: 'member-1' } }, query: {}, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
    });
}

const TIERS = { fast: { modelId: 'attacker-model', label: 'Fast' } };

test.beforeEach(() => { writes.length = 0; fx.admin = false; });

for (const url of ['/config/chat-models', '/config/chat-models-eu']) {
    test(`POST ${url} by a member who is not an admin is refused, and nothing is written`, async () => {
        const res = await dispatch({ method: 'POST', url, body: TIERS });
        assert.strictEqual(res.statusCode, 403);
        assert.deepStrictEqual(writes, []);
    });

    test(`POST ${url} by an admin still saves`, async () => {
        fx.admin = true;
        const res = await dispatch({ method: 'POST', url, body: TIERS });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(writes.length, 1);
    });

    test(`GET ${url} stays readable for every member — the tier pickers read it`, async () => {
        const res = await dispatch({ method: 'GET', url });
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.body.fast, 'the default tiers come back');
    });
}
