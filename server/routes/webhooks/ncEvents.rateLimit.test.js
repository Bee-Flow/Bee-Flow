/**
 * The Nextcloud user-sync webhook is rate-limited per IP, ahead of the body
 * parser, like the connector's other inbound route (/api/automation/events/*,
 * routes/automation/events.js). It used to have no limiter at all: every
 * request, signed or not, cost a JSON parse, an org lookup and a secret read.
 *
 * The ceiling is the same env knob (AUTOMATION_EVENTS_RPM_PER_IP), set to 2
 * here so the third request in the minute shows the 429. A body that is not
 * even JSON gets that 429 too: the limiter runs before the parser.
 *
 * The org lookup is the one auth/connectorSig.js makes, replaced through its
 * _setDepsForTests seam; the database is core/http/routeHarness.js's recorder,
 * so the stores the router pulls in at load time never reach Postgres.
 *
 * Run: cd server && node --test routes/webhooks/ncEvents.rateLimit.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.AUTOMATION_EVENTS_RPM_PER_IP = '2';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const h = require('../../core/http/routeHarness');
const connectorSig = require('../../auth/connectorSig');

const lookups = [];
connectorSig._setDepsForTests({
    userStore: () => ({ getOrganizationByNcInstanceId: async (id) => { lookups.push(id); return null; } }),
    configStore: () => ({ getSecret: async () => null }),
});
const db = h.recordDb();

const router = require('./ncEvents');

const PATH = '/auth/webhook/nc-user-sync';
let base;
let server;

test.before(async () => {
    await db.settle();
    const app = express();
    app.use('/auth', router);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    connectorSig._setDepsForTests();
    server.closeAllConnections();
    server.close();
});

const hit = (body) => fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Beeflow-NC-Instance-Id': 'nc-x', 'X-Beeflow-Sig': '1.00' },
    body,
});

test('past the per-IP ceiling the webhook answers 429, before parsing or looking anything up', async () => {
    const body = JSON.stringify({ event: 'user.deleted', ncUid: 'alice', groupId: null });
    assert.strictEqual((await hit(body)).status, 401);
    assert.strictEqual((await hit(body)).status, 401);
    assert.strictEqual(lookups.length, 2);

    const limited = await hit('{ not json');
    assert.strictEqual(limited.status, 429, 'the limiter runs ahead of the body parser');
    assert.strictEqual(lookups.length, 2, 'a limited request never reaches the org lookup');
});
