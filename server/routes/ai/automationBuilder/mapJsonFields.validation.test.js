/**
 * What POST /map-json-fields accepts (routes/ai/automationBuilder/mapJsonFields.js).
 *
 * `existingFields` tells the model which names the parse_json step already
 * has. Anything that was not a list of { name, path, description } — or the
 * key misspelled — was read as "nothing mapped yet", so the model re-proposed
 * those names and the editor dropped them as duplicates without a word. The
 * sample itself is the user's data and stays open; validateMapJsonRequest
 * keeps bounding it, with the sentences automationBuilder.mapJson.test.js pins.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/mapJsonFields.validation.test.js
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
            return { structured: { fields: [{ name: 'email', path: 'contact.email' }] } };
        },
    },
    '../../../auth/permissions': { requireAuth: pass },
    './rateLimits': { mapJsonFieldsRateLimit: pass },
    '../../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:map-json-fields-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /automationBuilder[\\/]mapJsonFields\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./mapJsonFields');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch(body) {
    const url = '/map-json-fields';
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

const SAMPLE = { contact: { email: 'a@example.test', name: 'A' } };

test('existingFields as a comma string is refused — it used to mean "nothing mapped"', async () => {
    const res = await dispatch({ sample: SAMPLE, instruction: 'the email', existingFields: 'name,email' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.existingFields'));
    assert.deepStrictEqual(modelCalls, []);
});

test('an existing field with a misspelled key is refused, not filtered out', async () => {
    const res = await dispatch({ sample: SAMPLE, instruction: 'the email', existingFields: [{ name: 'name', paht: 'contact.name' }] });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(modelCalls, []);
});

test('a misspelled envelope key is refused rather than ignored', async () => {
    const res = await dispatch({ sample: SAMPLE, instruction: 'the email', existing_fields: [] });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(modelCalls, []);
});

test('an instruction that is not text is refused by name', async () => {
    const res = await dispatch({ sample: SAMPLE, instruction: ['the email'] });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'The instruction must be text.');
});

test('a blank instruction keeps the helper\'s sentence', async () => {
    const res = await dispatch({ sample: SAMPLE, instruction: '   ' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'An instruction describing the fields you want is required.');
    assert.deepStrictEqual(modelCalls, []);
});

test('the editor\'s own request reaches the model with the names it already has', async () => {
    const res = await dispatch({
        sample: SAMPLE,
        instruction: 'the email',
        existingFields: [{ name: 'name', path: 'contact.name', description: '' }],
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(modelCalls[0][1].content, /- name: contact\.name/);
    assert.strictEqual(res.body.fields[0].name, 'email');
    assert.strictEqual(res.body.fields[0].verified, true);
});
