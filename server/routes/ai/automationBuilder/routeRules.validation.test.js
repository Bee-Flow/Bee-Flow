/**
 * What POST /route-rules accepts, and what it says when it refuses
 * (routes/ai/automationBuilder/routeRules.js).
 *
 * routeRules.test.js pins the two guardrails of the pure helpers; this pins
 * the door in front of them:
 *
 *   - `perItem: "false"` used to read as true, and the model was told each
 *     condition runs once per row;
 *   - a field object that carries a value (`sampleValue`) is refused at the
 *     door instead of trimmed quietly;
 *   - a key too long to show whole is left out, never cut — a cut key is a
 *     field that does not exist, and verification used to accept a rule
 *     over it because the cut key WAS declared;
 *   - the beta gate still answers before the schema, so a 403 stays a 403.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/routeRules.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every model call lands in `asked`. A refused request must leave it empty.
const asked = [];
let modelAnswer = { rules: [] };
let betaOn = true;
const pass = (req, res, next) => next();

const MOCKS = {
    '../../../core/llm/modelResolver': { resolveModelForTierName: async () => 'fast-model' },
    '../../../core/llm/llmClient': {
        chatForcedTool: async (modelId, messages) => { asked.push(messages); return { structured: modelAnswer }; },
    },
    '../../../auth/permissions': { requireAuth: pass },
    './rateLimits': { routeRulesRateLimit: pass },
    '../../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => betaOn },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:route-rules-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /automationBuilder[\\/]routeRules\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./routeRules');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function post(body) {
    const url = '/route-rules';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through: POST /route-rules'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const FIELDS = [{ key: 'name', name: 'File name', type: 'text' }, { key: 'status', name: 'Status', type: 'text' }];

test.beforeEach(() => { asked.length = 0; modelAnswer = { rules: [] }; betaOn = true; });

test('perItem as the text "false" is refused, instead of telling the model "per row"', async () => {
    const res = await post({ description: 'split by status', fields: FIELDS, perItem: 'false' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.perItem'));
    assert.deepStrictEqual(asked, []);
});

test('a whole-run condition is described to the model as one', async () => {
    const res = await post({ description: 'split by status', fields: FIELDS, perItem: false });
    assert.strictEqual(res.statusCode, 200);
    assert.match(asked[0][1].content, /once for the whole run/);
});

test('a field that carries a value is refused at the door — values never go out', async () => {
    const res = await post({
        description: 'split by type',
        fields: [{ key: 'name', name: 'File name', sampleValue: 'Jan de Vries - offerte.pdf' }],
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.fields.0'));
    assert.deepStrictEqual(asked, []);
});

test('an empty description is refused in words, not with "Required"', async () => {
    const res = await post({ fields: FIELDS });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Describe the outputs you want.');
    assert.deepStrictEqual(asked, []);
});

test('a key too long to show whole is left out, so no rule can name a cut version of it', async () => {
    const long = 'x'.repeat(250);
    modelAnswer = { rules: [{ name: 'Long', expr: `item.${long.slice(0, 200)} == "a"` }, { name: 'Named', expr: 'item.name == "a"' }] };
    const res = await post({ description: 'split it', fields: [{ key: 'name' }, { key: long }] });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!asked[0][1].content.includes(long.slice(0, 200)), 'the cut key is never shown to the model');
    assert.deepStrictEqual(res.body.rules.map((r) => r.name), ['Named']);
});

test('the beta gate answers before the schema: a 403 stays a 403', async () => {
    betaOn = false;
    const res = await post({ description: 42 });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(asked, []);
});
