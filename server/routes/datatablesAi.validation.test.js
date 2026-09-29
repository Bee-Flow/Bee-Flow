/**
 * What POST /api/datatables/ai/draft accepts, and what it says when it
 * refuses (routes/datatablesAi.js).
 *
 * `mode` was read as `=== 'revise' ? 'revise' : 'create'`, so `'Revise'` — or
 * any other spelling — DREW A NEW TABLE from the brief instead of revising the
 * one in the designer, and answered 200 with a draft that looked plausible.
 * `allowDestructive: 'true'` (text) was read as no, without a word.
 *
 * The mount calls `draft(req, res)` without a `next`, so the route applies
 * its schema itself and answers in validate()'s envelope. What this file pins:
 *
 *   - the 400 NAMES the field (`body.mode`), in a sentence, code
 *     `invalid_request`;
 *   - no model is asked for a refused request;
 *   - the AI panel's two bodies still draft.
 *
 * Run: cd server && node --test routes/datatablesAi.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every model call lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    '../stores/userStore': { getUser: async () => ({ id: 'u1', organizationId: 'org1' }) },
    '../stores/usageStore': { logUsage: async () => {} },
    '../core/llm/modelResolver': {
        resolveModelForTier: async () => 'fast-model',
        resolveModelWithGlobalFallback: async () => 'fast-model',
    },
    '../core/llm/llmClient': {
        chatForcedTool: async (modelId, messages) => {
            touched.push({ what: 'chatForcedTool', args: [messages] });
            return { structured: { name: 'Invoices', fields: [{ name: 'Supplier', type: 'text' }] }, usage: {} };
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:dt-ai-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]datatablesAi\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { draft, DraftBody } = require('./datatablesAi');
test.after(() => { Module._resolveFilename = originalResolve; });

async function call(body) {
    const res = { statusCode: 200, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await draft({ body, session: { user: { id: 'u1' } } }, res);
    return res;
}

const CURRENT = { name: 'Customers', fields: [{ id: 'fld_a1', key: 'email', name: 'E-mail', type: 'text' }] };

test.beforeEach(() => { touched.length = 0; });

test('a misspelled mode is refused, instead of drawing a new table over the one being revised', async () => {
    const res = await call({ mode: 'Revise', note: 'add a phone number', brief: 'customers', current: CURRENT });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, {
        error: 'mode is "create" or "revise".',
        code: 'invalid_request',
        details: [{ path: 'body.mode', message: 'mode is "create" or "revise".' }],
    });
    assert.deepStrictEqual(touched, [], 'no model was asked');
});

test('"true" as text is refused, instead of being read as no', async () => {
    const res = await call({ mode: 'revise', note: 'drop notes', current: CURRENT, allowDestructive: 'true' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'allowDestructive is true or false.');
    assert.deepStrictEqual(touched, []);
});

test('a list for current and a misspelled key are refused', async () => {
    let res = await call({ mode: 'revise', note: 'x', current: [CURRENT] });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.current'));
    res = await call({ mode: 'create', breif: 'invoices' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('the AI panel\'s create and revise bodies still draft', async () => {
    let res = await call({ mode: 'create', brief: 'Track supplier invoices', current: null });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.mode, 'create');
    res = await call({ mode: 'revise', note: 'add a phone number', current: CURRENT, allowDestructive: false });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.mode, 'revise');
    assert.strictEqual(touched.length, 2);
});

test('no mode is still a create, the default it always had', async () => {
    const res = await call({ brief: 'Track supplier invoices' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.mode, 'create');
});

test('a change request longer than the model is sent is refused, not cut without a word', async () => {
    const note = `Add a phone number column. ${'Also keep the e-mail column as it is. '.repeat(70)}And rename Customers to Clients.`;
    assert.ok(note.length > 2000 && note.length <= 12000, 'longer than the cap, shorter than the designer\'s box');
    const res = await call({ mode: 'revise', note, current: CURRENT });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A change request is at most 2000 characters — shorten it, or split it into two.');
    assert.ok(res.body.details.some((d) => d.path === 'body.note'));
    assert.deepStrictEqual(touched, [], 'the model never saw the first 2000 characters alone');
});

test('a request at the cap still drafts, whole', async () => {
    const note = 'x'.repeat(2000);
    const res = await call({ mode: 'revise', note: `  ${note}  `, current: CURRENT });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(JSON.stringify(touched[0].args[0]).includes(note));
});

test('a brief longer than the model is sent is refused the same way', async () => {
    const res = await call({ mode: 'create', brief: 'y'.repeat(12001) });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.brief'));
    assert.deepStrictEqual(touched, []);
});

test('the schema is exported for the mount, and applying it twice changes nothing', () => {
    const once = DraftBody.parse({ mode: 'revise', note: 'x', current: CURRENT });
    assert.deepStrictEqual(DraftBody.parse(once), once);
});
