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

// The real stores over a recording pool: a refused request sends no query beyond the gate's load of the
// base (requireKbGrade runs before the schema, so a stranger gets the 404 whatever they send).
const h = require('../../testUtils/routeHarness');
const KB_ID = '11111111-1111-4111-8111-111111111111';
const db = h.recordDb((sql) => (/FROM knowledge_bases/i.test(sql) ? { rows: [{ id: KB_ID, tenant_id: 'u1', organization_id: 'org1', name: 'Handboek' }] } : undefined));
const pastTheGate = () => db.queries.filter((q) => !/knowledge_bases/i.test(q));
const pass = (req, res, next) => next();
h.openGates({
    requireAuth: pass, requireAdmin: pass, requireSuperAdmin: pass, requireOrgAdmin: () => pass,
    requirePrimaryOrgAdmin: () => pass, requirePermission: () => pass, requirePluginAdmin: pass,
    requireActiveOrg: pass, requireActiveOrgForMutations: () => pass,
});

const router = require('./n8n');

const { dispatcher } = require('../../testUtils/routeHarness');

const dispatch = dispatcher(router);

test.before(() => db.settle());
test.beforeEach(() => { db.reset(); });

test('no workflow id is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: `/${KB_ID}/ingest/n8n`, body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A workflow id is required — which n8n workflow to read.');
    assert.ok(res.body.details.some((d) => d.path === 'body.workflowId'));
    assert.deepStrictEqual(pastTheGate(), [], 'and nothing is read');
});

test('a mode that is neither is refused by name, rather than running the workflow', async () => {
    // Anything that was not the literal 'definition' fell back to 'data',
    // which EXECUTES the workflow's webhook. A typo did that silently.
    const res = await dispatch({ method: 'POST', url: `/${KB_ID}/ingest/n8n`, body: { workflowId: 'wf1', mode: 'defenition' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'mode is "data" (run the webhook) or "definition" (the flow itself).');
    assert.ok(res.body.details.some((d) => d.path === 'body.mode'));
    assert.deepStrictEqual(pastTheGate(), []);
});

test('a key the route does not read is refused rather than answered with a 201', async () => {
    const res = await dispatch({ method: 'POST', url: `/${KB_ID}/ingest/n8n`, body: { workflowId: 'wf1', modus: 'definition' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(pastTheGate(), []);
});
