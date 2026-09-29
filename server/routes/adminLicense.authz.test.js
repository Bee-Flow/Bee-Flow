/**
 * /api/admin/licenses — authorization tests.
 *
 * WHY THIS FILE EXISTS: this router mints licences for an arbitrary
 * organizationId taken straight from the request body, lists every org's
 * licences including the re-importable blob, and imports unsigned blobs. It was
 * gated by auth/permissions.requireAdmin, which passes on the `manage_users`
 * permission — and config/orgRoles.json grants `manage_users` to org_admin. A
 * 2026-08-10 pentest used exactly that to mint itself an enterprise licence
 * from a freshly self-registered account. The router header had said
 * "Super-admin only" since v1; only the gate disagreed.
 *
 * The gate under test is the REAL auth/permissions.requireSuperAdmin — it is
 * deliberately not stubbed. Only leaf dependencies are replaced, so a
 * regression in the gate fails here rather than in production.
 *
 * Verifies:
 *   - 401 unauthenticated on every endpoint
 *   - 403 for a default org_admin (the pentest actor) AND for a user holding
 *     the 'all' permission via a group/custom role, on every endpoint
 *   - 200 for a platform admin
 *   - the exact pentest payload is refused, and no licence is issued as a
 *     side effect of a denied request
 *
 * Run: node --test routes/adminLicense.authz.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Module = require('module');

process.env.NODE_ENV = 'test';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

// ── Leaf stubs. Any call recorded here during a denied request is a bug. ────
const issued = [];
const imported = [];
const revoked = [];
const extended = [];

mock('../db', {
    exec: async () => ({ rows: [], rowCount: 0 }),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
});

mock('../license/adminIssuance', {
    BLOB_PREFIX: 'bfl_',
    publicLicenseShape: (l) => ({ id: l.id, tier: l.tier, organizationId: l.organizationId }),
    issueAdminLicense: async (payload) => {
        issued.push(payload);
        return { license: { id: 'lic_new', tier: payload.tier, organizationId: payload.organizationId }, blob: 'bfl_x' };
    },
    importAdminLicense: async (payload) => {
        imported.push(payload);
        return { license: { id: 'lic_imported', tier: 'enterprise', organizationId: 'someorg' } };
    },
});

mock('../license/store', {
    getAdminIssuedLicenses: async () => ([
        { id: 'lic_1', tier: 'enterprise', organizationId: 'bee-flow', rawToken: 'bfl_secret_blob' },
    ]),
    deactivateLicense: async (id) => { revoked.push(id); return true; },
    extendExpiry: async (id, exp) => { extended.push({ id, exp }); return { id, expiresAt: exp }; },
    getLicenseById: async (id) => ({ id, tier: 'enterprise', organizationId: 'bee-flow' }),
});

mock('../stores/userStore', {
    getAllOrganizations: async () => ([{ id: 'bee-flow', name: 'Bee Flow' }]),
    getUser: async () => null,
});

mock('../utils/emailService', {
    sendServiceEmail: async () => ({ ok: true }),
    getServiceEmailConfig: async () => ({ configured: false }),
});

const express = require('express');
const adminLicenseRouter = require('./adminLicense');

let server, baseUrl;
let session = null;

before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = session; next(); });
    app.use('/api/admin/licenses', adminLicenseRouter);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

beforeEach(() => {
    issued.length = 0;
    imported.length = 0;
    revoked.length = 0;
    extended.length = 0;
});

async function call(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
        body: body != null ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const PLATFORM_ADMIN = { isAuthenticated: true, isAdmin: true, user: { id: 'admin1', role: 'admin' } };

// The pentest actor: a self-registered org founder. accountProvisioning gives
// the founder orgRole 'org_admin', and orgRoles.json gives that `manage_users`.
// It holds NO 'all' — that is the point. requireAdmin admitted it anyway.
const ORG_ADMIN_DEFAULT = {
    isAuthenticated: true,
    user: { id: 'pentester2', role: 'user', orgRole: 'org_admin', organizationId: 'pentestorg-twee' },
};

// The other way in: any user granted 'all' through a group or custom role.
const ALL_PERM_HOLDER = {
    isAuthenticated: true,
    user: { id: 'orgadmin1', role: 'user', permissions: ['all'] },
};

// Every mutating endpoint, plus both reads.
const ENDPOINTS = [
    ['GET', '/api/admin/licenses/capabilities', null],
    ['GET', '/api/admin/licenses?includeInactive=true', null],
    ['POST', '/api/admin/licenses/grant', { scope: 'organization', tier: 'enterprise', organizationId: 'bee-flow' }],
    ['POST', '/api/admin/licenses/lic_1/revoke', {}],
    ['POST', '/api/admin/licenses/lic_1/extend', { expiresAt: '2027-12-31T00:00:00Z' }],
    ['POST', '/api/admin/licenses/import', { blob: 'bfl_stolen' }],
];

test('401 unauthenticated on every endpoint', async () => {
    session = null;
    for (const [method, path, body] of ENDPOINTS) {
        const res = await call(method, path, body);
        assert.strictEqual(res.status, 401, `${method} ${path} should be 401 for an anonymous caller`);
    }
});

test('403 for a default org_admin on every endpoint', async () => {
    session = ORG_ADMIN_DEFAULT;
    for (const [method, path, body] of ENDPOINTS) {
        const res = await call(method, path, body);
        assert.strictEqual(res.status, 403, `${method} ${path} must not be reachable by an org admin`);
        // Bind the assertion to the gate that must be doing the denying.
        // requireAdmin answers 'Admin access required' and would let this
        // caller through entirely; requireSuperAdmin answers this. Without the
        // message check a stubbed-out permission lookup could make a 403 look
        // correct for the wrong reason.
        assert.strictEqual(
            res.body?.error, 'Operator access required',
            `${method} ${path} must be denied by requireSuperAdmin, not by some other gate`,
        );
    }
});

test("403 for a holder of the 'all' permission on every endpoint", async () => {
    session = ALL_PERM_HOLDER;
    for (const [method, path, body] of ENDPOINTS) {
        const res = await call(method, path, body);
        assert.strictEqual(res.status, 403, `${method} ${path} must not be reachable via the 'all' permission`);
    }
});

test('a denied request has no side effects', async () => {
    session = ORG_ADMIN_DEFAULT;
    await call('POST', '/api/admin/licenses/grant', { scope: 'organization', tier: 'enterprise', organizationId: 'bee-flow' });
    await call('POST', '/api/admin/licenses/import', { blob: 'bfl_stolen' });
    await call('POST', '/api/admin/licenses/lic_1/revoke', {});
    await call('POST', '/api/admin/licenses/lic_1/extend', { expiresAt: '2027-12-31T00:00:00Z' });
    assert.deepStrictEqual(issued, [], 'no licence may be issued for a denied caller');
    assert.deepStrictEqual(imported, [], 'no blob may be imported for a denied caller');
    assert.deepStrictEqual(revoked, [], "no licence may be revoked for a denied caller");
    assert.deepStrictEqual(extended, [], 'no licence may be extended for a denied caller');
});

// The verbatim request from the 2026-08-10 pentest report, which returned a
// working enterprise licence. Pinned so the exact exploit stays closed.
test('the pentest grant payload is refused', async () => {
    session = ORG_ADMIN_DEFAULT;
    const res = await call('POST', '/api/admin/licenses/grant', {
        tier: 'enterprise',
        organizationId: 'pentestorg-twee',
        expiresAt: '2026-12-31T00:00:00Z',
    });
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(issued, []);
});

// Cross-org disclosure: the list returns every org's licence row including the
// raw, re-importable blob. That is acceptable for a platform operator and for
// nobody else.
test('the cross-org licence list is refused to an org admin', async () => {
    session = ORG_ADMIN_DEFAULT;
    const res = await call('GET', '/api/admin/licenses?includeInactive=true', null);
    assert.strictEqual(res.status, 403);
    assert.ok(
        !JSON.stringify(res.body ?? {}).includes('bfl_secret_blob'),
        'a denied response must not leak a licence blob',
    );
});

test('a platform admin still passes', async () => {
    session = PLATFORM_ADMIN;
    assert.strictEqual((await call('GET', '/api/admin/licenses/capabilities', null)).status, 200);
    assert.strictEqual((await call('GET', '/api/admin/licenses', null)).status, 200);

    // With the expiry adminIssuance always required — the stub above does not
    // check it, the route's schema now does, before the stub is reached.
    const grant = await call('POST', '/api/admin/licenses/grant', {
        scope: 'organization', tier: 'enterprise', organizationId: 'bee-flow', expiresAt: '2027-12-31T00:00:00Z',
    });
    assert.strictEqual(grant.status, 200);
    assert.strictEqual(issued.length, 1, 'the platform admin grant must reach adminIssuance');
});
