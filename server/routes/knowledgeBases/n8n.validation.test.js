/**
 * What n8n ingestion accepts, and what it says when it refuses
 * (routes/knowledgeBases/n8n.js).
 *
 * `mode` decides whether the route READS THE FLOW or RUNS ITS WEBHOOK, and
 * `mode = 'data'` was the default for every value that was not the literal
 * string 'definition' — so `mode: 'defenition'` silently fired the workflow
 * instead of describing it, and answered 201. What this file pins is the part
 * a caller can act on:
 *
 *   - the 400 NAMES the field (`body.mode`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/n8n.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const KB = { id: 'kb1', tenant_id: 'owner1', organization_id: 'org1' };

const MOCKS = {
    '../../stores/knowledgeBases': {
        getKB: async (id) => { touched.push({ what: 'getKB', args: [id] }); return { ...KB }; },
    },
    '../../stores/configStore': {
        getConfig: async () => null,
        getSecret: async () => null,
    },
    '../../auth': { requireAuth: pass, requirePermission: () => pass },
    '../../core/kb/kbIngestionHelpers': {
        ingestDocument: async (...a) => { touched.push({ what: 'ingestDocument', args: a }); return { document: { id: 'd1' }, chunks: 1 }; },
    },
    './shared': {
        getUserId: (req) => req.session?.user?.id || null,
        canAccessKB: async () => true,
        blockIfSystemKB: () => false,
        ensureKbSource: async (...a) => { touched.push({ what: 'ensureKbSource', args: a }); return { id: 's1' }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-n8n-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]n8n\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./n8n');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router);

test.beforeEach(() => { touched.length = 0; });

test('no workflow id is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/n8n', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A workflow id is required — which n8n workflow to read.');
    assert.ok(res.body.details.some((d) => d.path === 'body.workflowId'));
    assert.deepStrictEqual(touched, [], 'and nothing is read');
});

test('a mode that is neither is refused by name, rather than running the workflow', async () => {
    // Anything that was not the literal 'definition' fell back to 'data',
    // which EXECUTES the workflow's webhook. A typo did that silently.
    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/n8n', body: { workflowId: 'wf1', mode: 'defenition' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'mode is "data" (run the webhook) or "definition" (the flow itself).');
    assert.ok(res.body.details.some((d) => d.path === 'body.mode'));
    assert.deepStrictEqual(touched, []);
});

test('a key the route does not read is refused rather than answered with a 201', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/n8n', body: { workflowId: 'wf1', modus: 'definition' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});
