'use strict';

// An App Studio step answers with one JSON body when the step is done, which for an AI step over a
// stack of documents takes minutes. The 60 s response-headers timeout cut every such step off in
// Nextcloud; a step request gets the longer wait, everything else keeps the guard.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = process.env.APP_SECRET || 'test-app-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nc.test';
delete process.env.BEEFLOW_UPSTREAM_HEADERS_TIMEOUT_MS;

const { headersTimeoutFor, isStudioStepRequest, STEP_HEADERS_TIMEOUT_MS } = require('../src/proxy');

const req = (method, url) => /** @type {import('http').IncomingMessage} */ (/** @type {unknown} */ ({ method, url }));

test('the step route of an app is a step request, with or without a query', () => {
    assert.equal(isStudioStepRequest(req('POST', '/api/studio-apps/app1/actions/act_1/step')), true);
    assert.equal(isStudioStepRequest(req('POST', '/api/studio-apps/app1/actions/act_1/step?draft=1')), true);
});

test('other routes are not: another method, the browse stream, a deeper path, an empty id', () => {
    assert.equal(isStudioStepRequest(req('GET', '/api/studio-apps/app1/actions/act_1/step')), false);
    assert.equal(isStudioStepRequest(req('POST', '/api/studio-apps/app1/actions/act_1/step/stream')), false);
    assert.equal(isStudioStepRequest(req('POST', '/api/studio-apps/app1/actions/act_1/runs/end')), false);
    assert.equal(isStudioStepRequest(req('POST', '/api/studio-apps//actions/act_1/step')), false);
    assert.equal(isStudioStepRequest(req('POST', '/api/chat/step')), false);
});

test('a step waits the step timeout, anything else the default 60 s', () => {
    assert.equal(headersTimeoutFor(req('POST', '/api/studio-apps/app1/actions/act_1/step')), STEP_HEADERS_TIMEOUT_MS);
    assert.equal(headersTimeoutFor(req('GET', '/api/health')), 60_000);
    assert.ok(STEP_HEADERS_TIMEOUT_MS > 375_000, 'longer than the browser waits for a step');
});
