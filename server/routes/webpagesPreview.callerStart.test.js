/**
 * A webpage button that starts an automation names the logged-in visitor as
 * the run's starter (taken from the signed preview claims, never the request),
 * so an automation on runPolicy.connections = 'caller' acts for THEM. An
 * anonymous visitor has no starter.
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

const CTX = {
    webpage: { name: 'Page' }, authorUserId: 'author-1', authorOrgId: 'org-1', authorSession: null,
    bridgeGrants: { automations: [{ automationId: 'auto-1' }] },
};

const restore = installResolveStub({
    './webpagesPreviewRateLimits': {
        llmBridgeLimiter: pass, sideEffectBridgeLimiter: pass, integrationBridgeLimiter: pass, dbBridgeLimiter: pass,
    },
    './webpagesPreviewTables': express.Router(),
    '../stores/webpageDbStore': {},
    '../stores/webpageStore': {},
    '../stores/automationStore': {
        getAutomation: async () => ({ id: 'auto-1', userId: 'author-1', definition: {} }),
        getRun: async (id) => ({ id, userId: 'author-1', status: 'success', output: { v: 'zebra' }, error: null, connectionsMode: 'caller', startedByUserId: 'viewer-1' }),
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
