'use strict';

/**
 * A14 — inbound webhook: trigger.output stays the RAW POST body; request
 * headers ride additively (allowlisted, auth pair stripped, snake_cased) into
 * executeAutomation as `triggerHeaders`.
 *
 * Handler invoked directly with a mocked store/runner — same harness family
 * as crud.multiTrigger.test.js.
 *
 * Run: node --test routes/automation/events.webhookPayload.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const SECRET = 'shh'.repeat(12);
let executions = [];

mock(path.join(SERVER, 'stores/automationStore'), {
    getWebhook: async (slug) => (slug === 'hook1' ? { id: 'hook1', automationId: 'auto1', secret: SECRET, triggerStepId: 'trg2' } : null),
    checkAndStoreNonce: async () => true,
    touchWebhook: async () => {},
    getAutomation: async () => ({ id: 'auto1', isActive: true, isDraft: false, definition: { trigger: { id: 'trg1', kind: 'manual' } } }),
});
mock(path.join(SERVER, 'automation/triggerBus'), { dispatchEvent: async () => [] });
mock(path.join(SERVER, 'core/automationRunner'), {
    executeAutomation: async (automation, opts) => { executions.push({ automation, opts }); return { id: 'run1' }; },
});

const eventsRouter = require('./events');

function findHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

const handler = findHandler(eventsRouter, 'post', '/webhook/:slug');

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

function signedReq(body, extraHeaders = {}) {
    const nonce = 'nonce-1';
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${nonce}\n${JSON.stringify(body)}`).digest('hex');
    const headers = {
        'content-type': 'application/json',
        'user-agent': 'curl/8',
        'x-beeflow-signature': sig,
        'x-beeflow-nonce': nonce,
        ...extraHeaders,
    };
    return {
        params: { slug: 'hook1' },
        body,
        headers,
        get: (name) => headers[String(name).toLowerCase()],
    };
}

const flushAsync = () => new Promise(r => setImmediate(() => setImmediate(r)));

test('trigger.output is the raw POST body; headers ride separately, snake_cased, auth pair stripped', async () => {
    executions = [];
    const res = makeRes();
    await handler(signedReq({ orderId: 123, body: 'not a wrapper' }, { 'x-correlation-id': 'abc' }), res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(executions.length, 1);
    const { opts } = executions[0];
    // The body IS the payload — no {body, headers} wrapper.
    assert.deepStrictEqual(opts.triggerPayload, { orderId: 123, body: 'not a wrapper' });
    // Headers: allowlisted + snake_cased for bind.js's dotted-path grammar.
    assert.strictEqual(opts.triggerHeaders.content_type, 'application/json');
    assert.strictEqual(opts.triggerHeaders.user_agent, 'curl/8');
    assert.strictEqual(opts.triggerHeaders.x_correlation_id, 'abc');
    // The BeeFlow auth pair must never reach run state / run history.
    assert.ok(!('x_beeflow_signature' in opts.triggerHeaders));
    assert.ok(!('x_beeflow_nonce' in opts.triggerHeaders));
    // Multi-trigger seeding unchanged.
    assert.strictEqual(opts.rootStepId, 'trg2');
});

test('non-allowlisted headers are dropped', async () => {
    executions = [];
    await handler(signedReq({ a: 1 }, { authorization: 'Bearer nope', cookie: 'session=1' }), makeRes());
    await flushAsync();
    const h = executions[0].opts.triggerHeaders;
    assert.ok(!('authorization' in h) && !('cookie' in h));
});

test('a bad signature still 401s (guard unchanged)', async () => {
    executions = [];
    const req = signedReq({ a: 1 });
    req.headers['x-beeflow-signature'] = 'sha256=' + '0'.repeat(64);
    const res = makeRes();
    await handler(req, res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(executions.length, 0);
});
