'use strict';

/**
 * The address of a webhook trigger over HTTP (routes/studioAppWebhook.mts), behind the body
 * parsers the server mounts (boot/httpMiddleware.js) and the real stores on PGlite
 * (testUtils/webhookTriggerHarness.testkit.js): the bytes that were sent are what is signed, and
 * a caller without the secret gets one answer.
 *
 * Run: cd server && node --test routes/studioAppWebhook.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { webhookHarness } = require('../testUtils/webhookTriggerHarness.testkit');
const { textWithoutCorrelationId } = require('../testUtils/routeHarness');
const { applyBodyParsers } = require('../boot/httpMiddleware');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
const { makeStudioAppWebhookRouter } = require('./studioAppWebhook.mts');

const h = webhookHarness({ before, after, beforeEach });
const { publish, unpublish, signed, definition, hook, row, settle, runs } = h;

const servers = [];
after(async () => { for (const s of servers) await new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve); }); });

/** The router as index.js mounts it, with the harness's stores and `env` as the operator's settings. */
async function serve(env = {}) {
    const app = express();
    applyBodyParsers(app);
    app.use('/api/app-hooks', makeStudioAppWebhookRouter(h.receiveDeps(), env));
    app.use(terminalErrorHandler);
    const server = http.createServer(app);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/app-hooks`;
    /** Send a delivery of the harness as a request. */
    return async (d, { method = 'POST', type = 'application/json' } = {}) => {
        const res = await fetch(`${base}/${d.endpointId}`, {
            method, body: method === 'GET' ? undefined : d.rawBody,
            headers: { 'content-type': type, 'x-beeflow-signature': d.signature, 'x-beeflow-timestamp': d.timestamp, 'x-beeflow-nonce': d.nonce },
        });
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, body, text, headers: res.headers };
    };
}
const UNKNOWN = { endpointId: 'e'.repeat(48) };

test('a signed delivery is accepted over HTTP: the signature covers the bytes as sent, whitespace and key order included', async () => {
    await publish(definition([hook()]));
    const send = await serve();
    const res = await send(await signed('{ "b" : 1,\n  "a" : [ 2 ] }'));
    assert.equal(res.status, 202, res.text);
    assert.equal(res.body.accepted, true);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await settle((await row('hook')).lastRunId);
    assert.deepEqual(h.s.executed[0].ctx.trigger.webhook.body, { b: 1, a: [2] });
});

test('unknown address, wrong signature, unpublished app: one status and one body, and nothing that names the app', async () => {
    await publish(definition([hook()]));
    const send = await serve();
    const answers = [await send(await signed({ a: 1 }, UNKNOWN)), await send(await signed({ a: 1 }, { secret: 'wrong' }))];
    const known = await signed({ a: 1 });
    await unpublish();
    answers.push(await send(known));
    assert.deepEqual(answers.map((r) => r.status), [404, 404, 404]);
    assert.equal(new Set(answers.map(textWithoutCorrelationId)).size, 1, answers.map((r) => r.text).join('\n'));
    assert.equal(answers.some((r) => r.text.includes('app_1') || r.text.includes('hook')), false);
    assert.deepEqual(await runs(), []);
});

test('a wrong content type is 415 and a body over the limit is 413, the same for a known and an unknown address, before any signature is read', async () => {
    await publish(definition([hook()]));
    const send = await serve({ STUDIO_APP_WEBHOOK_BODY_MAX_BYTES: '64' });
    const small = await signed({ a: 1 });
    const large = await signed({ text: 'x'.repeat(200) });
    for (const d of [small, { ...small, ...UNKNOWN }]) assert.equal((await send(d, { type: 'text/plain' })).status, 415);
    for (const d of [large, { ...large, ...UNKNOWN }]) assert.equal((await send(d)).status, 413);
    assert.equal((await send(small)).status, 202, 'a body inside the limit goes through');
    assert.equal((await send(small, { method: 'GET' })).status, 404, 'the address only takes a POST');
});

test('one address sends only so many requests a minute, whatever it sends and wherever to', async () => {
    await publish(definition([hook()]));
    const send = await serve({ STUDIO_APP_WEBHOOK_RPM_PER_IP: '2' });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await send(await signed({ i }, UNKNOWN))).status);
    assert.deepEqual(statuses, [404, 404, 429]);
});

test('a trigger over its deliveries per minute answers 429 with Retry-After to a signed caller', async () => {
    await publish(definition([hook()]));
    h.w.limits.rpmPerTrigger = 1;
    const send = await serve();
    assert.equal((await send(await signed({ n: 1 }))).status, 202);
    await settle((await row('hook')).lastRunId);
    const res = await send(await signed({ n: 2 }));
    assert.deepEqual([res.status, res.body.code, res.headers.get('retry-after')], [429, 'rate_limited', '30']);
});
