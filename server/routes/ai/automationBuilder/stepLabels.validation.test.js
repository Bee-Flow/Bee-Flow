/**
 * What POST /label-steps accepts (routes/ai/automationBuilder/stepLabels.js).
 *
 * `allowedIcons` is the client's renderable icon set. Anything but a list —
 * or the key misspelled — was read as "no icons": the model got no list,
 * every icon it proposed was filtered out, and the labels still came back,
 * so it looked like the feature worked. `definition` is the draft on screen
 * and keeps the definition schema's own keys.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/stepLabels.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const modelCalls = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../../core/llm/modelResolver': { resolveModelForTierName: async () => 'm-fast' },
    '../../../core/llm/llmClient': {
        chatForcedTool: async (modelId, messages) => {
            modelCalls.push(messages);
            return { structured: { steps: [{ id: 's1', label: 'Send Welcome Mail', icon: 'Mail' }, { id: 's2', label: 'Wait', icon: 'Rocket' }] } };
        },
    },
    '../../../auth/permissions': { requireAuth: pass },
    './rateLimits': { summariseLayerRateLimit: pass },
    '../../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:step-labels-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /automationBuilder[\\/]stepLabels\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./stepLabels');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch(body) {
    const url = '/label-steps';
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

test.beforeEach(() => { modelCalls.length = 0; });

const DEF = { trigger: { type: 'manual' }, steps: [{ id: 's1', type: 'send_email' }, { id: 's2', type: 'wait' }] };

test('allowedIcons as a string is refused — it used to mean "no icons", silently', async () => {
    const res = await dispatch({ definition: DEF, allowedIcons: 'Mail,Send' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.allowedIcons'));
    assert.deepStrictEqual(modelCalls, []);
});

test('a misspelled allowedIcons key is refused rather than dropped', async () => {
    const res = await dispatch({ definition: DEF, allowedicons: ['Mail'] });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(modelCalls, []);
});

test('a definition without steps keeps its sentence', async () => {
    const res = await dispatch({ definition: { trigger: {} }, allowedIcons: ['Mail'] });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A definition with steps is required.');
    assert.deepStrictEqual(modelCalls, []);
});

test('the builder\'s own request labels the steps, with icons only from its list', async () => {
    const res = await dispatch({ definition: DEF, allowedIcons: ['Mail', 'Send', 'Clock'] });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(modelCalls[0][1].content, /Allowed icon names:\nMail, Send, Clock/);
    assert.deepStrictEqual(res.body.labels, {
        s1: { label: 'Send Welcome Mail', icon: 'Mail' },
        s2: { label: 'Wait' },
    }, 'an icon outside the list is still dropped');
});
