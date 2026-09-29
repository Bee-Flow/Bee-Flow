/**
 * Toolbox provisioning (Track C) — /toolbox/status shape + the super-admin gate.
 *
 *  1. scanRunnerSvc.toolboxStatus() returns the exact { dockerOk, imageOk, image,
 *     canPull, canBuild } shape the route sends. Run directly against the service
 *     so the assertion is docker-independent (dockerOk may be true or false here;
 *     only the shape/types are asserted). canBuild is true because the shipped
 *     Dockerfile asset is present next to the module.
 *  2. GET /toolbox/status is gated to super-admins (req.session.isAdmin ||
 *     user.role === 'admin'); a normal user gets 403.
 *  3. POST /toolbox/provision validates the mode.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const scanRunnerSvc = require('../server/src/scanRunner.service');
const { mountSecurityRoutes } = require('../server/src/routes');
const { makeHostMock } = require('./hostMock');
const { serve } = require('./httpHarness');

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'terminal-runner');

test('scanRunnerSvc.toolboxStatus returns the { dockerOk, imageOk, image, canPull, canBuild } shape', async () => {
    const status = await scanRunnerSvc.toolboxStatus({ assetsDir: ASSETS_DIR });
    assert.strictEqual(typeof status.dockerOk, 'boolean');
    assert.strictEqual(typeof status.imageOk, 'boolean');
    assert.strictEqual(typeof status.image, 'string');
    assert.ok(status.image.length > 0, 'image tag present');
    assert.strictEqual(typeof status.canPull, 'boolean');
    assert.strictEqual(status.canBuild, true, 'the shipped Dockerfile makes a build possible');
});

// Route-level tests use a STUBBED scanRunnerSvc so the gate/shape assertions
// never depend on a docker daemon.
function stubSvc(overrides = {}) {
    return {
        toolboxStatus: overrides.toolboxStatus || (async () => ({ dockerOk: true, imageOk: false, image: 'beeflow-security-tools:latest', canPull: false, canBuild: true })),
        provisionToolbox: overrides.provisionToolbox || (async () => ({ imageOk: true })),
        dockerAvailable: async () => true,
        prewarmToolbox: () => null,
        releasePrewarm: async () => {},
    };
}

function mount(session, svc = stubSvc()) {
    const host = makeHostMock();
    const worker = { drainOne: async () => {} };
    const router = host.express.Router();
    mountSecurityRoutes(router, { store: {}, scanRunnerSvc: svc, worker, host });
    return serve(router, { session });
}

test('GET /toolbox/status returns the shape for a super-admin', async () => {
    const { base, close } = await mount({ user: { id: 'admin1', role: 'admin' } });
    try {
        const res = await fetch(`${base}/toolbox/status`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.deepStrictEqual(Object.keys(body).sort(), ['canBuild', 'canPull', 'dockerOk', 'image', 'imageOk']);
        assert.strictEqual(body.image, 'beeflow-security-tools:latest');
    } finally {
        await close();
    }
});

test('GET /toolbox/status is 403 for a non-super-admin', async () => {
    const { base, close } = await mount({ user: { id: 'u2', role: 'user' } });
    try {
        const res = await fetch(`${base}/toolbox/status`);
        assert.strictEqual(res.status, 403);
        const body = await res.json();
        assert.strictEqual(body.error, 'super_admin_required');
    } finally {
        await close();
    }
});

test('GET /toolbox/status honours the session.isAdmin flag too', async () => {
    const { base, close } = await mount({ isAdmin: true, user: { id: 'a3' } });
    try {
        const res = await fetch(`${base}/toolbox/status`);
        assert.strictEqual(res.status, 200);
    } finally {
        await close();
    }
});

test('POST /toolbox/provision rejects an invalid mode with 400', async () => {
    const { base, close } = await mount({ user: { id: 'admin1', role: 'admin' } });
    try {
        const res = await fetch(`${base}/toolbox/provision`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'nonsense' }),
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.match(body.error, /build.*pull/);
    } finally {
        await close();
    }
});
