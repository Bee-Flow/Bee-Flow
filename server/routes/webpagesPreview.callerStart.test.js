/**
 * What the signed preview claims decide in the bridge.
 *
 * A webpage button that starts an automation names the logged-in visitor as
 * the run's starter (taken from the claims, never the request), so an
 * automation on runPolicy.connections = 'caller' acts for THEM. An anonymous
 * visitor has no starter. The run routes answer only for runs THIS page
 * started.
 *
 * The page database's write bridges (beeflowDB.exec / batch) belong to the
 * author: a reader holds a viewer token, reads, and writes only when the
 * author opted the page in (bridge_grants.db.viewersMayWrite), read at the
 * moment of use.
 *
 * Run: cd server && node --test routes/webpagesPreview.callerStart.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { installResolveStub } = require('../testUtils/stubRequire');
const { serveRouter } = require('../testUtils/toolPiiGateHarness');

const pass = (req, res, next) => next();
let claims = { viewerUserId: 'viewer-1', webpageId: 'wp-1' };
const executions = [];
let grants = { db: { viewersMayWrite: false } };
const writes = [];
let cancelled = [];
const RUN_9 = { id: 'run-9', userId: 'author-1', status: 'success', output: { v: 'zebra' }, error: null, connectionsMode: 'caller', startedByUserId: 'viewer-1', triggerPayload: { _webpageId: 'wp-1' } };
const runs = {
    'run-9': RUN_9,
    'run-elsewhere': { id: 'run-elsewhere', userId: 'author-1', status: 'success', output: { v: 2 }, error: null, triggerPayload: { source: 'schedule' } },
    'run-other-page': { id: 'run-other-page', userId: 'author-1', status: 'running', output: null, error: null, triggerPayload: { _webpageId: 'wp-2' } },
};

const CTX = {
    webpage: { name: 'Page' }, authorUserId: 'author-1', authorOrgId: 'org-1', authorSession: null,
    bridgeGrants: { automations: [{ automationId: 'auto-1' }] },
};

const restore = installResolveStub({
    './webpagesPreviewRateLimits': {
        llmBridgeLimiter: pass, sideEffectBridgeLimiter: pass, integrationBridgeLimiter: pass, dbBridgeLimiter: pass,
    },
    './webpagesPreviewTables': express.Router(),
    '../stores/webpageDbStore': {
        query: async () => ({ rows: [{ a: 1 }], columns: ['a'], truncated: false }),
        exec: async (...args) => { writes.push(['exec', ...args]); return { changes: 1, lastInsertRowid: 1 }; },
        batch: async (...args) => { writes.push(['batch', ...args]); return [{ changes: 1 }]; },
        schema: async () => ({ tables: [] }),
    },
    '../stores/webpageStore': { getBridgeGrants: async () => grants },
    '../stores/automationStore': {
        getAutomation: async () => ({ id: 'auto-1', userId: 'author-1', definition: {} }),
        getRun: async (id) => runs[id] || null,
        getRunSteps: async () => [{ runId: 'run-9', stepId: 's1', stepType: 'integration_action', status: 'success', input: { q: 'zebra' }, output: { v: 'zebra' }, error: null }],
    },
    '../auth/webpagePreviewToken': {
        requirePreviewToken: (req, res, next) => { req.previewClaims = { ...claims }; next(); },
    },
    '../core/webpages/webpageBridgeAuth': { loadAuthorContext: async () => CTX },
    '../core/tools/toolDispatcher': { executeTool: async () => ({}) },
    '../automation/toolRegistry': { findOwnerOfTool: () => null, loadTools: () => [] },
    '../integrations/webpageFramework': { resolveRuntime: () => 'static' },
    '../integrations/webpageApiRuntime': { executeApiHandler: async () => ({}) },
    './webpagesPreviewAi': { chat: pass, stream: pass },
    './webpagesPreviewAsk': { ask: pass },
    '../core/automationRunner': {
        executeAutomation: async (automation, opts) => { executions.push(opts); return { id: 'run-1', status: 'success' }; },
        requestCancel: async (id) => { cancelled.push(id); },
    },
});
test.after(() => restore());

const router = require('./webpagesPreview');
const base = serveRouter(test, router, { prefix: '/api/webpages-preview' });

async function start(wait) {
    const res = await fetch(`${base()}/wp-1/automations/auto-1/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // A claimed starter in the body must never be believed.
        body: JSON.stringify({ wait, inputs: {}, startedByUserId: 'someone-else', _viewerUserId: 'someone-else' }),
    });
    return res.status;
}

test('a logged-in visitor is the starter, from the claims, with and without waiting', async () => {
    claims = { viewerUserId: 'viewer-1', webpageId: 'wp-1' };
    executions.length = 0;
    assert.strictEqual(await start(true), 200);
    assert.strictEqual(await start(false), 200);
    assert.strictEqual(executions.length, 2);
    for (const opts of executions) {
        assert.strictEqual(opts.triggerKind, 'webpage');
        assert.strictEqual(opts.startedByUserId, 'viewer-1');
        assert.strictEqual(opts.triggerPayload._viewerUserId, 'viewer-1');
    }
});

test('an anonymous visitor has no starter', async () => {
    claims = { viewerUserId: null, webpageId: 'wp-1' };
    executions.length = 0;
    await start(true);
    assert.strictEqual(executions[0].startedByUserId, null);
});

test('polling a run on the starter\'s own connections: the starter sees its values, another visitor only the status', async () => {
    const poll = async (viewerUserId, tail = '') => {
        claims = { viewerUserId, webpageId: 'wp-1' };
        return (await fetch(`${base()}/wp-1/automations/runs/run-9${tail}`)).json();
    };
    assert.deepStrictEqual((await poll('viewer-1')).output, { v: 'zebra' });
    const other = await poll('viewer-2');
    assert.strictEqual(other.status, 'success');
    assert.strictEqual(other.output, null);
    assert.strictEqual((await poll('viewer-1', '/steps')).steps[0].output.v, 'zebra');
    const hidden = (await poll('viewer-2', '/steps')).steps[0];
    assert.deepStrictEqual([hidden.stepId, hidden.status, 'input' in hidden, 'output' in hidden], ['s1', 'success', false, false]);
});

async function post(route, body) {
    const res = await fetch(`${base()}/wp-1${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

test('a viewer token reads the page database but may not write through exec or batch', async () => {
    claims = { viewerUserId: 'viewer-1', webpageId: 'wp-1', role: 'viewer' };
    grants = { db: { viewersMayWrite: false } };
    writes.length = 0;
    const read = await post('/db/query', { sql: 'SELECT 1' });
    assert.strictEqual(read.status, 200);
    for (const [route, body] of [['/db/exec', { sql: 'DROP TABLE t' }], ['/db/batch', { statements: [{ sql: 'DROP TABLE t' }] }]]) {
        const res = await post(route, body);
        assert.strictEqual(res.status, 403, route);
        assert.strictEqual(res.body.code, 'db_write_forbidden');
    }
    assert.deepStrictEqual(writes, [], 'nothing reached the store');
});

test('a token without any role claim is a viewer', async () => {
    claims = { viewerUserId: 'viewer-1', webpageId: 'wp-1' };
    grants = { db: { viewersMayWrite: false } };
    assert.strictEqual((await post('/db/exec', { sql: 'DELETE FROM t' })).status, 403);
});

test('the author opting the page in lets a viewer write, read at the moment of use', async () => {
    claims = { viewerUserId: 'viewer-1', webpageId: 'wp-1', role: 'viewer' };
    grants = { db: { viewersMayWrite: true } };
    writes.length = 0;
    assert.strictEqual((await post('/db/exec', { sql: 'INSERT INTO t VALUES (1)' })).status, 200);
    assert.strictEqual((await post('/db/batch', { statements: [{ sql: 'INSERT INTO t VALUES (2)' }] })).status, 200);
    assert.strictEqual(writes.length, 2);
    // Switched off again: the next call is refused without a new token.
    grants = { db: { viewersMayWrite: false } };
    assert.strictEqual((await post('/db/exec', { sql: 'INSERT INTO t VALUES (3)' })).status, 403);
    assert.strictEqual(writes.length, 2);
});

test('the owner token writes without consulting the grant', async () => {
    claims = { viewerUserId: 'author-1', webpageId: 'wp-1', role: 'owner' };
    grants = null; // a store that answers nothing must not matter for the author
    writes.length = 0;
    assert.strictEqual((await post('/db/exec', { sql: 'CREATE TABLE t (a)' })).status, 200);
    assert.strictEqual(writes.length, 1);
});

test('run status, steps and cancel answer only for runs this page started', async () => {
    claims = { viewerUserId: 'viewer-1', webpageId: 'wp-1', role: 'viewer' };
    cancelled = [];
    const get = async (runId, tail = '') => (await fetch(`${base()}/wp-1/automations/runs/${runId}${tail}`)).status;
    assert.strictEqual(await get('run-9'), 200);
    assert.strictEqual(await get('run-9', '/steps'), 200);
    // The author's run from a schedule, and a run of another page: not this page's.
    for (const id of ['run-elsewhere', 'run-other-page', 'run-missing']) {
        assert.strictEqual(await get(id), 404, id);
        assert.strictEqual(await get(id, '/steps'), 404, `${id} steps`);
        const res = await fetch(`${base()}/wp-1/automations/runs/${id}/cancel`, { method: 'POST' });
        assert.strictEqual(res.status, 404, `${id} cancel`);
    }
    assert.deepStrictEqual(cancelled, [], 'no foreign run was cancelled');
    const own = await fetch(`${base()}/wp-1/automations/runs/run-9/cancel`, { method: 'POST' });
    assert.strictEqual(own.status, 200);
    assert.deepStrictEqual(cancelled, ['run-9']);
});
