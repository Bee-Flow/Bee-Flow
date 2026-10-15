'use strict';
/**
 * Wire contract of the fail-closed gates that answer 5xx through the terminal
 * error handler (next(HttpError)) instead of writing the response themselves.
 *
 * Per gate: the status, the body token clients branch on (`error` equals the
 * old token, `code` repeats it) and, the point of a gate, that the request
 * does NOT reach the next handler. Mobile retries on 503 + `entitlement_unavailable`
 * (mobile/src/core/api/client.ts), so the status and `Retry-After` stay as they were.
 *
 * Run: cd server && node --test --test-force-exit auth/gates.wire.test.js
 */
process.env.NODE_ENV = 'test';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const h = require('../testUtils/routeHarness');
const { buildKey } = require('../utils/buildInfo');
const license = require('../license');

const closers = [];
after(() => Promise.all(closers.map((c) => c())));

/** Serve `mw` followed by a handler that records whether it was reached. */
function gated(mw, opts) {
    const state = { reached: false };
    const router = express.Router();
    router.use(mw);
    router.get('/x', (_req, res) => { state.reached = true; res.json({ ok: true }); });
    const api = h.serve('/', router, opts);
    closers.push(api.close);
    return { state, get: () => api.call('GET', '/x') };
}

function assertRefusal(res, state, status, token, extra = {}) {
    assert.equal(res.status, status);
    assert.equal(res.body.error, token);
    assert.equal(res.body.code, extra.code ?? token);
    assert.ok(res.body.correlationId, 'a correlationId the user can quote');
    assert.equal(state.reached, false, 'the request must not reach the next handler');
}

test('microsoft session gate: binding lookup failure is 503 auth_unavailable and never passes', async () => {
    const { createMicrosoftSessionMiddleware } = require('./microsoftSession');
    const identity = { azureTenantId: '11111111-1111-1111-1111-111111111111', azureUserId: '22222222-2222-2222-2222-222222222222', revision: '4' };
    const mw = createMicrosoftSessionMiddleware({ getIdentityBinding: async () => { throw new Error('db down'); } });
    const g = gated(mw, { session: { oauthProvider: 'microsoft', microsoftIdentityVersion: 2, microsoftLoginIdentity: identity } });
    assertRefusal(await g.get(), g.state, 503, 'auth_unavailable');
});

test('feature gate: unreadable flag is 503 and never passes; the sentence stays the message', async () => {
    const filename = require.resolve('../stores/configStore');
    require.cache[filename] = { id: filename, filename, loaded: true, exports: { getConfig: async () => { throw new Error('refused'); } } };
    const { featureGate } = require('../boot/featureGate');
    const g = gated(featureGate('projects', 'Projects'));
    assertRefusal(await g.get(), g.state, 503, 'Projects availability could not be determined', { code: 'feature_gate_unavailable' });
});

function licenseSession(value) {
    const ver = license.getServerLicenseVersion();
    return { [buildKey(`_lic:u1:v${ver}`)]: { expiresAt: Date.now() + 60_000, value } };
}

for (const [name, build] of [
    ['requireTier', (m) => m.requireTier('enterprise')],
    ['requireFeature', (m) => m.requireFeature('notebooks')],
]) {
    test(`license ${name}: unresolvable tier is 503 tier_unavailable and never passes`, async () => {
        const mw = build(require('../license/middleware'));
        const session = licenseSession({ error: 'tier_unavailable', tier: 'community', orgIds: [], orgTiers: {} });
        const g = gated(mw, { session });
        const res = await g.get();
        assertRefusal(res, g.state, 503, 'tier_unavailable');
        assert.deepEqual(res.body.details, { retry_after: 1 });
    });
}

test('requireCapability: degraded snapshot and a throwing resolver are both 503 entitlement_unavailable with Retry-After', async () => {
    const { requireCapability } = require('../core/entitlements/entitlements');
    const registry = require('../core/entitlements/capabilityRegistry');
    const capId = Object.keys(registry.CAPABILITIES || registry.REGISTRY || {})[0] || 'meeting_notes';
    const ver = license.getServerLicenseVersion();
    const key = buildKey(`_ent:u1:o${h.USER.organizationId}:v${ver}`);

    const degraded = gated(requireCapability(capId), { session: { [key]: { expiresAt: Date.now() + 60_000, value: { degraded: true } } } });
    let res = await degraded.get();
    assertRefusal(res, degraded.state, 503, 'entitlement_unavailable');
    assert.equal(res.headers.get('retry-after'), '1');
    assert.deepEqual(res.body.details, { retry_after: 1 });

    // A session whose entitlement memo cannot even be read: the resolver throws.
    const throwing = new Proxy({ isAuthenticated: true, user: h.USER }, {
        get(t, p) { if (typeof p === 'string' && p.startsWith('_ent')) throw new Error('boom'); return t[p]; },
    });
    const state = { reached: false };
    const app = express();
    app.use((req, _r, next) => { req.session = throwing; next(); });
    app.use(requireCapability(capId));
    app.use((_q, r) => { state.reached = true; r.json({}); });
    app.use(require('../core/http/terminalErrorHandler').terminalErrorHandler);
    const srv = app.listen(0, '127.0.0.1');
    closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
    await new Promise((r) => srv.once('listening', r));
    const raw = await fetch(`http://127.0.0.1:${srv.address().port}/x`);
    const body = await raw.json();
    assert.equal(raw.status, 503);
    assert.equal(body.error, 'entitlement_unavailable');
    assert.equal(body.code, 'entitlement_unavailable');
    assert.equal(raw.headers.get('retry-after'), '1');
    assert.equal(state.reached, false);
});
