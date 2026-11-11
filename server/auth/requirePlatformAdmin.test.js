/**
 * auth/requirePlatformAdmin — the gate of instance-wide settings.
 *
 * The gate is built here with a fixture isSuperAdmin (the barrel builds it
 * with the real one; createPlatformAdminGate is the seam). Verifies, in the
 * cloud and the self-hosted deployment mode alike:
 *   - a platform admin (session flag or `admin` user role) passes;
 *   - an org_admin is refused, whatever organisation permission they hold
 *     (admin_ai_config, admin_security, manage_users, 'all');
 *   - the middleware answers 401 without a session, 403 with the same body the
 *     AI admin routers use, and `next()` for a platform admin;
 *   - the middleware is tagged on the platform axis (the route contract and
 *     the access-registry drift test read that tag);
 *   - the barrel exports a gate wired to the real isSuperAdmin;
 *   - the two routers that mount it bare — the guard installer and the
 *     platform branding writes — refuse an org_admin before any store or
 *     installer is reached (testUtils/routeHarness, gates replaced through the
 *     barrel, the database recorded).
 *
 * Run: cd server && node --test auth/requirePlatformAdmin.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { createPlatformAdminGate } = require('./requirePlatformAdmin');
const h = require('../testUtils/routeHarness');

const gate = createPlatformAdminGate({
    isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
});
const { hasPlatformAdminAccess, requirePlatformAdmin } = gate;

const PLATFORM_ADMIN = { isAuthenticated: true, isAdmin: true, user: { id: 'admin1', role: 'admin' } };
const ADMIN_BY_ROLE = { isAuthenticated: true, user: { id: 'admin2', role: 'admin' } };
const ORG_ADMIN = { isAuthenticated: true, user: { id: 'orgadmin1', role: 'user', orgRole: 'org_admin', organizationId: 'org-a' } };

const MODES = ['cloud', 'self-hosted'];

/**
 * Runs `fn` once per deployment mode (license.deploymentMode reads the env).
 * @param {(mode: string) => Promise<void>} fn
 */
async function inEachMode(fn) {
    const before = process.env.DEPLOYMENT_MODE;
    try {
        for (const mode of MODES) {
            process.env.DEPLOYMENT_MODE = mode;
            await fn(mode);
        }
    } finally {
        if (before === undefined) delete process.env.DEPLOYMENT_MODE;
        else process.env.DEPLOYMENT_MODE = before;
    }
}

// ── hasPlatformAdminAccess ──────────────────────────────────────────────────

test('a platform admin passes in cloud and self-hosted alike', async () => {
    await inEachMode(async (mode) => {
        assert.strictEqual(await hasPlatformAdminAccess({ session: PLATFORM_ADMIN }, 'admin_ai_config'), true, mode);
        assert.strictEqual(await hasPlatformAdminAccess({ session: ADMIN_BY_ROLE }, 'admin_ai_config'), true, `${mode} (role)`);
    });
});

test('an org_admin is refused in cloud and self-hosted alike, whichever permission the call site names', async () => {
    await inEachMode(async (mode) => {
        for (const permission of ['admin_ai_config', 'admin_security', 'manage_users', 'all']) {
            assert.strictEqual(await hasPlatformAdminAccess({ session: ORG_ADMIN }, permission), false, `${mode}: ${permission}`);
        }
    });
});

test('no session, or a session without a user, is refused', async () => {
    await inEachMode(async (mode) => {
        assert.strictEqual(await hasPlatformAdminAccess({ session: undefined }, 'admin_ai_config'), false, mode);
        assert.strictEqual(await hasPlatformAdminAccess({ session: { isAuthenticated: true } }, 'admin_ai_config'), false, mode);
    });
});

// ── requirePlatformAdmin (middleware) ───────────────────────────────────────

function run(mw, session) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b, next: false }); return this; },
        };
        mw({ session }, res, () => resolve({ status: 200, body: null, next: true }));
    });
}

test('middleware: 401 without a session, 403 for an org_admin, next() for a platform admin, in both modes', async () => {
    const mw = requirePlatformAdmin('manage_users');
    await inEachMode(async (mode) => {
        assert.deepStrictEqual(await run(mw, null), { status: 401, body: { error: 'Not authenticated' }, next: false }, mode);
        assert.deepStrictEqual(await run(mw, { isAuthenticated: false, user: { id: 'x' } }), { status: 401, body: { error: 'Not authenticated' }, next: false }, mode);
        assert.deepStrictEqual(await run(mw, ORG_ADMIN), { status: 403, body: { error: 'Admin access required' }, next: false }, mode);
        assert.deepStrictEqual(await run(mw, PLATFORM_ADMIN), { status: 200, body: null, next: true }, mode);
        assert.deepStrictEqual(await run(mw, ADMIN_BY_ROLE), { status: 200, body: null, next: true }, `${mode} (role)`);
    });
});

test('the middleware is tagged on the platform axis, with no permission a tenant could hold', () => {
    const { readGate } = require('./gateMeta');
    const meta = readGate(requirePlatformAdmin('admin_security'));
    assert.deepStrictEqual({ ...meta }, { axis: 'platform', kind: 'superAdmin' });
});

test('the barrel exports a gate built on the real isSuperAdmin', async () => {
    const barrel = require('./permissions');
    assert.strictEqual(typeof barrel.hasPlatformAdminAccess, 'function');
    assert.strictEqual(typeof barrel.requirePlatformAdmin, 'function');
    // The decision is isSuperAdmin alone, so this holds without a database.
    await inEachMode(async (mode) => {
        assert.strictEqual(await barrel.hasPlatformAdminAccess({ session: PLATFORM_ADMIN }, 'admin_ai_config'), true, mode);
        assert.strictEqual(await barrel.hasPlatformAdminAccess({ session: ADMIN_BY_ROLE }, 'manage_users'), true, mode);
        assert.strictEqual(await barrel.hasPlatformAdminAccess({ session: ORG_ADMIN }, 'admin_ai_config'), false, mode);
    });
});

// ── The routers that mount it bare ──────────────────────────────────────────
//
// Served the way index.js serves them, with the fixture gate in the barrel's
// place (openGates runs before the routers are required, which is when they
// destructure it) and every database call recorded.

const db = h.recordDb();
h.openGates({ hasPlatformAdminAccess, requirePlatformAdmin });
const guard = h.serve('/api/admin/guard', require('../routes/guardInstall'));
const branding = h.serve('/api/branding', require('../routes/branding'));
test.before(() => db.settle());
test.after(() => { guard.close(); branding.close(); });
test.beforeEach(() => db.reset());

const ORG_ADMIN_USER = { ...h.USER, role: 'user', orgRole: 'org_admin' };
const ADMIN_USER = { ...h.USER, role: 'admin' };
const writes = () => db.queries.filter((q) => /INSERT|UPDATE|DELETE/i.test(q));

test('guard installer: an org_admin is refused on every route before the installer is reached, in both modes', async () => {
    await inEachMode(async (mode) => {
        for (const [method, url, body] of [['GET', '/status'], ['POST', '/install', { model: 'm' }], ['POST', '/uninstall', { removeVolume: true }]]) {
            const res = await guard.call(method, `/api/admin/guard${url}`, { body, user: ORG_ADMIN_USER });
            assert.strictEqual(res.status, 403, `${mode} ${method} ${url}: ${res.text}`);
            assert.deepStrictEqual(res.body, { error: 'Admin access required' });
        }
        assert.deepStrictEqual(db.queries, [], mode);
    });
    // The positive paths (202 from a platform admin) are the gate's own tests
    // above plus guardInstall.validation.test.js: the real installer talks to
    // Docker, so it is not called here.
});

test('platform branding: an org_admin cannot read or write the instance default in either mode; a platform admin can', async () => {
    await inEachMode(async (mode) => {
        db.reset();
        const read = await branding.call('GET', '/api/branding/admin', { user: ORG_ADMIN_USER });
        assert.strictEqual(read.status, 403, `${mode}: ${read.text}`);
        const write = await branding.call('PUT', '/api/branding/admin', { body: { preset: 'dark' }, user: ORG_ADMIN_USER });
        assert.strictEqual(write.status, 403, `${mode}: ${write.text}`);
        assert.deepStrictEqual(writes(), [], `${mode}: a refused write reaches no store`);
        const admin = await branding.call('PUT', '/api/branding/admin', { body: { preset: 'dark' }, user: ADMIN_USER });
        assert.strictEqual(admin.status, 200, `${mode}: ${admin.text}`);
        assert.ok(writes().length > 0, `${mode}: the platform admin wrote`);
        // A member keeps their own override: that route is requireAuth, not the admin gate.
        const member = await branding.call('PUT', '/api/branding/user', { body: { preset: 'dark' }, user: h.USER });
        assert.strictEqual(member.status, 200, `${mode}: ${member.text}`);
    });
});

test('platform branding: the admin routes carry the platform tag through the safe() wrapper', () => {
    const { readGate } = require('./gateMeta');
    const brandingRouter = require('../routes/branding');
    const admin = brandingRouter.stack.find((l) => l.route && l.route.path === '/admin' && l.route.methods.put);
    assert.ok(admin, 'PUT /admin is mounted');
    const tags = admin.route.stack.map((s) => readGate(s.handle)).filter(Boolean);
    assert.ok(tags.some((t) => t.axis === 'platform' && t.kind === 'superAdmin'), `tags: ${JSON.stringify(tags)}`);
});
