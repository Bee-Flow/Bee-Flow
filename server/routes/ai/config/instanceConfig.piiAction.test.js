/**
 * The instance-wide PII action (POST /ai/config, routes/ai/config/instanceConfig.js).
 *
 * piiDetectionAction was stored exactly as sent. 'allow' is a real value in
 * core/privacy/piiDetection/validate.js — a per-call override for trusted
 * first-party flows — and it makes the scan skip entirely, so an instance
 * config holding it switched PII detection off for every org that falls back
 * to it. Found while reconciling validation batch 2a. The accepted set is the
 * one the signup and org-shield screens already use: block, tokenize, warn.
 *
 * Run: cd server && node --test routes/ai/config/instanceConfig.piiAction.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const saved = [];
const writes = [];

const MOCKS = {
    '../../../core/aiAgent': {
        getAIConfig: async () => ({ piiDetectionAction: 'block' }),
        saveAIConfig: async (cfg) => { saved.push(cfg); return true; },
    },
    '../../../stores/configStore': {
        getConfig: async () => null,
        setConfig: async (key, value) => { writes.push([key, value]); },
    },
    './shared': { isAdminUser: async () => true },
    '../../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Not authenticated' })),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:instance-config-pii:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /config[\\/]instanceConfig\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./instanceConfig');
test.after(() => { Module._resolveFilename = originalResolve; });

function post(body) {
    return new Promise((resolve, reject) => {
        const req = { method: 'POST', url: '/config', body, headers: {}, session: { user: { id: 'admin-1' } }, query: {}, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error('fell through')));
    });
}

test.beforeEach(() => { saved.length = 0; writes.length = 0; });

test("'allow' — which skips the scan — is refused, and nothing at all is written", async () => {
    const res = await post({ piiDetectionAction: 'allow', allowedModelsByAgentType: { chat: ['m'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /piiDetectionAction is one of block, tokenize, warn/);
    assert.deepStrictEqual(saved, []);
    assert.deepStrictEqual(writes, [], 'the refusal comes before the first setConfig');
});

test('a misspelled action is refused rather than stored', async () => {
    const res = await post({ piiDetectionAction: 'blokc' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(saved, []);
});

test('each of the three real actions is saved', async () => {
    for (const action of ['block', 'tokenize', 'warn']) {
        saved.length = 0;
        const res = await post({ piiDetectionAction: action });
        assert.strictEqual(res.statusCode, 200, action);
        assert.strictEqual(saved[0].piiDetectionAction, action);
    }
});

test('leaving it out keeps the stored action', async () => {
    const res = await post({ piiDetectionEnabled: true });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(saved[0].piiDetectionAction, 'block');
});
