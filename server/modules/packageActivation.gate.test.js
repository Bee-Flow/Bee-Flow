// @typecheck strict
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

// ── A session before anything else ─────────────────────────────────────────

h.openGates(); // requireAuth becomes the harness's session check, read per request

test('no session: 401 from the host, the module router is not reached', async () => {
    let reached = false;
    const router = express.Router();
    router.get('/x', (_req, res) => { reached = true; res.json({ ok: true }); });
    const handle = _composeHandler({ moduleId: 'm2', router, gateCapability: null });
    const outer = express.Router();
    outer.use(handle);
    const api = h.serve('/', outer);
    after(() => api.close());
    const res = await api.call('GET', '/x', { user: null });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Not authenticated');
    assert.equal(reached, false);
    const ok = await api.call('GET', '/x');
    assert.equal(ok.status, 200);
    assert.equal(reached, true);
});

test('a manifest publicRoutes prefix answers without a session; its siblings still need one', async () => {
    const router = express.Router();
    router.post('/hook/incoming', (_req, res) => res.json({ hook: true }));
    router.get('/private', (_req, res) => res.json({ private: true }));
    const handle = _composeHandler({ moduleId: 'm3', router, gateCapability: null, publicRoutes: ['/hook'] });
    const outer = express.Router();
    outer.use(handle);
    const api = h.serve('/', outer);
    after(() => api.close());
    const hook = await api.call('POST', '/hook/incoming', { user: null, body: {} });
    assert.equal(hook.status, 200);
    assert.deepEqual(hook.body, { hook: true });
    const priv = await api.call('GET', '/private', { user: null });
    assert.equal(priv.status, 401);
});

test('a publicRoutes prefix matches on a path boundary only', async () => {
    const router = express.Router();
    router.get('/hook', (_req, res) => res.json({ hook: true }));
    router.get('/hookadmin', (_req, res) => res.json({ admin: true }));
    const handle = _composeHandler({ moduleId: 'm4', router, gateCapability: null, publicRoutes: ['/hook'] });
    const outer = express.Router();
    outer.use(handle);
    const api = h.serve('/', outer);
    after(() => api.close());
    const hook = await api.call('GET', '/hook?x=1', { user: null });
    assert.equal(hook.status, 200);
    const sibling = await api.call('GET', '/hookadmin', { user: null });
    assert.equal(sibling.status, 401);
});
