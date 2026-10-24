// @typecheck
'use strict';
/**
 * A module's router sits behind its capability gate. When the entitlement
 * outage arrives as next(err), the composed handler must forward the error and
 * NOT run the module router (fail closed).
 *
 * Run: cd server && node --test modules/packageActivation.gate.test.js
 */
process.env.NODE_ENV = 'test';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const h = require('../testUtils/routeHarness');
const license = require('../license');
const { buildKey } = require('../utils/buildInfo');
require('./packageLoader'); // wires the activation deps
const { _composeHandler } = require('./packageActivation');

test('degraded entitlement snapshot: 503 entitlement_unavailable, module router not reached', async () => {
    let reached = false;
    const router = express.Router();
    router.get('/x', (_req, res) => { reached = true; res.json({ ok: true }); });
    const handle = _composeHandler({ moduleId: 'm1', router, gateCapability: 'meeting_notes' });
    const outer = express.Router();
    outer.use(handle);
    const ver = license.getServerLicenseVersion();
    const key = buildKey(`_ent:u1:o${h.USER.organizationId}:v${ver}`);
    const api = h.serve('/', outer, { session: { [key]: { expiresAt: Date.now() + 60_000, value: { degraded: true } } } });
    after(() => api.close());
    const res = await api.call('GET', '/x');
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'entitlement_unavailable');
    assert.equal(reached, false);
});
