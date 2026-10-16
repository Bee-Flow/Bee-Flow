'use strict';
/**
 * /ai/chat/notebook/* composes the `notebooks` capability gate with the operator
 * kill-switch. The capability gate reports an entitlement outage as
 * next(err) (503 entitlement_unavailable); the composing continuation must
 * forward that error, not run the kill-switch and fall through to the handler.
 *
 * Run: cd server && node --test routes/ai.notebookGate.test.js
 */
process.env.NODE_ENV = 'test';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../testUtils/routeHarness');
const license = require('../license');
const { buildKey } = require('../utils/buildInfo');

test('degraded entitlement snapshot on /chat/notebook is 503 entitlement_unavailable and never reaches the handler', async () => {
    const ver = license.getServerLicenseVersion();
    const key = buildKey(`_ent:u1:o${h.USER.organizationId}:v${ver}`);
    const api = h.serve('/', require('./ai'), { session: { [key]: { expiresAt: Date.now() + 60_000, value: { degraded: true } } } });
    after(() => api.close());
    const res = await api.call('POST', '/chat/notebook/n1', { body: { message: 'hi' } });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'entitlement_unavailable');
    assert.equal(res.headers.get('retry-after'), '1');
});
