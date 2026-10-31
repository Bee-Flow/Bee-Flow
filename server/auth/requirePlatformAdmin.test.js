/**
 * auth/requirePlatformAdmin — the gate of instance-wide settings.
 *
 * The gate is built here with fixture collaborators (the barrel builds it with
 * the real ones; createPlatformAdminGate is the seam). Verifies:
 *   - a platform admin passes in every deployment mode;
 *   - on a self-hosted install the org-level permission the route always asked
 *     for still suffices (behaviour there is unchanged);
 *   - on a shared instance (cloud) that same permission is NOT enough: an
 *     org_admin gets 403, and the permission lookup is never consulted;
 *   - the middleware answers 401 without a session, 403 with the same body the
 *     AI admin routers use, and `next()` for an admin;
 *   - the barrel exports a gate wired to the real isSuperAdmin;
 *   - the two routers that mount it bare — the guard installer and the
 *     platform branding writes — refuse an org_admin in cloud mode before any
 *     store or installer is reached (testUtils/routeHarness, gates replaced
 *     through the barrel, the database recorded).
 *
 * Run: cd server && node --test auth/requirePlatformAdmin.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { createPlatformAdminGate } = require('./requirePlatformAdmin');
const h = require('../testUtils/routeHarness');

const fx = {
    mode: 'cloud',
    /** permissions the fixture lookup grants to any user id */
    perms: /** @type {string[]} */ ([]),
    lookups: 0,
};

const gate = createPlatformAdminGate({
    hasPermission: async (_userId, permission) => { fx.lookups++; return fx.perms.includes(permission) || fx.perms.includes('all'); },
    isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
    deploymentMode: () => fx.mode,
});
const { hasPlatformAdminAccess, requirePlatformAdmin } = gate;

const PLATFORM_ADMIN = { isAuthenticated: true, isAdmin: true, user: { id: 'admin1', role: 'admin' } };
const ADMIN_BY_ROLE = { isAuthenticated: true, user: { id: 'admin2', role: 'admin' } };
const ORG_ADMIN = { isAuthenticated: true, user: { id: 'orgadmin1', role: 'user', orgRole: 'org_admin', organizationId: 'org-a' } };

test.beforeEach(() => {
    fx.mode = 'cloud';
    fx.perms = [];
    fx.lookups = 0;
});

// ── hasPlatformAdminAccess ──────────────────────────────────────────────────

test('a platform admin passes in cloud and self-hosted alike, without a permission lookup', async () => {
    for (const mode of ['cloud', 'self-hosted']) {
        fx.mode = mode;
        assert.strictEqual(await hasPlatformAdminAccess({ session: PLATFORM_ADMIN }, 'admin_ai_config'), true, mode);
        assert.strictEqual(await hasPlatformAdminAccess({ session: ADMIN_BY_ROLE }, 'admin_ai_config'), true, `${mode} (role)`);
    }
    assert.strictEqual(fx.lookups, 0);
});

test('self-hosted: the org-level permission suffices', async () => {
    fx.mode = 'self-hosted';
    fx.perms = ['admin_ai_config'];
    assert.strictEqual(await hasPlatformAdminAccess({ session: ORG_ADMIN }, 'admin_ai_config'), true);
    fx.perms = ['manage_users'];
    assert.strictEqual(await hasPlatformAdminAccess({ session: ORG_ADMIN }, 'admin_ai_config'), false, 'a different permission does not');
    fx.perms = ['all'];
    assert.strictEqual(await hasPlatformAdminAccess({ session: ORG_ADMIN }, 'admin_security'), true, "'all' counts");
});

test('only the normalised word counts: license.deploymentMode owns the private-cloud alias', async () => {
    fx.mode = 'private-cloud';
    fx.perms = ['admin_ai_config'];
    assert.strictEqual(await hasPlatformAdminAccess({ session: ORG_ADMIN }, 'admin_ai_config'), false);
});

test('cloud: an org_admin holding the permission is refused, and the lookup is never consulted', async () => {
    fx.mode = 'cloud';
    fx.perms = ['admin_ai_config', 'admin_security', 'manage_users', 'all'];
    assert.strictEqual(await hasPlatformAdminAccess({ session: ORG_ADMIN }, 'admin_ai_config'), false);
    assert.strictEqual(await hasPlatformAdminAccess({ session: ORG_ADMIN }, 'manage_users'), false);
    assert.strictEqual(fx.lookups, 0, 'the decision is made before any permission is resolved');
});

test('no session, or a session without a user, is refused', async () => {
    fx.mode = 'self-hosted';
    fx.perms = ['admin_ai_config'];
    assert.strictEqual(await hasPlatformAdminAccess({ session: undefined }, 'admin_ai_config'), false);
    assert.strictEqual(await hasPlatformAdminAccess({ session: { isAuthenticated: true } }, 'admin_ai_config'), false);
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

test('middleware: 401 without a session, 403 for an org_admin in cloud, next() for a platform admin', async () => {
    const mw = requirePlatformAdmin('manage_users');
    assert.deepStrictEqual(await run(mw, null), { status: 401, body: { error: 'Not authenticated' }, next: false });
    assert.deepStrictEqual(await run(mw, { isAuthenticated: false, user: { id: 'x' } }), { status: 401, body: { error: 'Not authenticated' }, next: false });
    fx.perms = ['manage_users'];
    assert.deepStrictEqual(await run(mw, ORG_ADMIN), { status: 403, body: { error: 'Admin access required' }, next: false });
    assert.deepStrictEqual(await run(mw, PLATFORM_ADMIN), { status: 200, body: null, next: true });
    fx.mode = 'self-hosted';
    assert.deepStrictEqual(await run(mw, ORG_ADMIN), { status: 200, body: null, next: true }, 'self-hosted: the permission suffices');
});

test('the middleware is a tagged gate (the route table can read which permission it enforces)', () => {
    const { readGate } = require('./gateMeta');
    const meta = readGate(requirePlatformAdmin('admin_security'));
    assert.deepStrictEqual(meta?.anyOf, ['admin_security', 'all']);
});

test('the barrel exports a gate built on the real isSuperAdmin', async () => {
    const barrel = require('./permissions');
    assert.strictEqual(typeof barrel.hasPlatformAdminAccess, 'function');
    assert.strictEqual(typeof barrel.requirePlatformAdmin, 'function');
    // A platform admin is decided before any collaborator the barrel wired is
    // consulted, so this holds without a database.
    assert.strictEqual(await barrel.hasPlatformAdminAccess({ session: PLATFORM_ADMIN }, 'admin_ai_config'), true);
    assert.strictEqual(await barrel.hasPlatformAdminAccess({ session: ADMIN_BY_ROLE }, 'manage_users'), true);
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

test('guard installer: an org_admin in cloud mode is refused on every route before the installer is reached', async () => {
    fx.perms = ['admin_security'];
    for (const [method, url, body] of [['GET', '/status'], ['POST', '/install', { model: 'm' }], ['POST', '/uninstall', { removeVolume: true }]]) {
        const res = await guard.call(method, `/api/admin/guard${url}`, { body, user: ORG_ADMIN_USER });
        assert.strictEqual(res.status, 403, `${method} ${url}: ${res.text}`);
        assert.deepStrictEqual(res.body, { error: 'Admin access required' });
    }
    assert.deepStrictEqual(db.queries, []);
    // The positive paths (202 from a platform admin, self-hosted admin_security)
    // are the gate's own tests above plus guardInstall.validation.test.js: the
    // real installer talks to Docker, so it is not called here.
});

test('platform branding: an org_admin in cloud mode cannot read or write the instance default', async () => {
    fx.perms = ['manage_users'];
    const read = await branding.call('GET', '/api/branding/admin', { user: ORG_ADMIN_USER });
    assert.strictEqual(read.status, 403, read.text);
    const write = await branding.call('PUT', '/api/branding/admin', { body: { preset: 'dark' }, user: ORG_ADMIN_USER });
    assert.strictEqual(write.status, 403, write.text);
    assert.deepStrictEqual(writes(), [], 'a refused write reaches no store');
    const admin = await branding.call('PUT', '/api/branding/admin', { body: { preset: 'dark' }, user: ADMIN_USER });
    assert.strictEqual(admin.status, 200, admin.text);
    assert.ok(writes().length > 0, 'the platform admin wrote');
    db.reset();
    fx.mode = 'self-hosted';
    const self = await branding.call('PUT', '/api/branding/admin', { body: { preset: 'light' }, user: ORG_ADMIN_USER });
    assert.strictEqual(self.status, 200, `self-hosted: manage_users suffices: ${self.text}`);
    // A member keeps their own override: that route is requireAuth, not the admin gate.
    fx.mode = 'cloud';
    const member = await branding.call('PUT', '/api/branding/user', { body: { preset: 'dark' }, user: h.USER });
    assert.strictEqual(member.status, 200, member.text);
});
