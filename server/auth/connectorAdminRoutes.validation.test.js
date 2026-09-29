/**
 * What the connector tenant-key routes accept (auth/connectorAdminRoutes.js).
 *
 * A super-admin passes every org check, so a mistyped `:orgId` was answered
 * like a real one: POST minted a key for an organisation that does not exist —
 * and connectorJwt.js learns the tenant from WHICH key verifies a token, so a
 * connector holding it signed in as that phantom — while DELETE answered
 * `revoked: true` for the typo and left the real key working. What this file
 * pins:
 *
 *   - POST needs an organisation that exists, and takes no body;
 *   - DELETE needs a key to revoke, whether or not its org still exists;
 *   - the existence answer comes AFTER the admin check, never before it;
 *   - nothing is minted or revoked by a refused request.
 *
 * Run: cd server && node --test auth/connectorAdminRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every key write and cache bust lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const secrets = new Map();
const pass = (req, res, next) => next();

const MOCKS = {
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../stores/configStore': {
        getSecret: async (key) => secrets.get(key) || null,
        setSecret: async (key, value) => { touched.push({ what: 'setSecret', args: [key, value] }); secrets.set(key, value); },
    },
    '../stores/userStore': {
        getUser: async (id) => (id === 'orgadmin' ? { id, orgRole: 'org_admin', organizationId: 'org1' } : null),
        getOrganization: async (id) => (['org1', 'org2'].includes(id) ? { id, name: id } : null),
    },
    './permissions': { requireAuth: pass },
    './connectorJwt': { invalidateTenantKeyCache: (orgId) => { touched.push({ what: 'invalidateTenantKeyCache', args: [orgId] }); } },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:connector-admin-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]connectorAdminRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./connectorAdminRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

const SUPER_ADMIN = { isAdmin: true, user: { id: 'root', role: 'admin' } };
const ORG_ADMIN = { user: { id: 'orgadmin' } };

function dispatch({ method, url, body, session = SUPER_ADMIN }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => {
    touched.length = 0;
    secrets.clear();
    secrets.set('connector_tenant_key_org1', 'the-live-key');
});

// ── POST: mint or rotate ────────────────────────────────────────────

test('a mistyped org id is a 404, not a working key for an organisation that does not exist', async () => {
    const res = await dispatch({ method: 'POST', url: '/admin/connector/tenants/org-1/key' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.tenantKey, undefined);
    assert.deepStrictEqual(touched, [], 'no key was minted');
});

test('a body is refused, because the route always rotates the live key', async () => {
    const res = await dispatch({ method: 'POST', url: '/admin/connector/tenants/org1/key', body: { rotate: false } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === 'body' && /rotate/.test(d.message)));
    assert.deepStrictEqual(touched, [], 'the live key was not rotated');
    assert.strictEqual(secrets.get('connector_tenant_key_org1'), 'the-live-key');
});

test('an org admin asking about another organisation still hears 403, never whether it exists', async () => {
    for (const orgId of ['org2', 'no-such-org']) {
        const res = await dispatch({ method: 'POST', url: `/admin/connector/tenants/${orgId}/key`, session: ORG_ADMIN });
        assert.strictEqual(res.statusCode, 403, orgId);
    }
    assert.deepStrictEqual(touched, []);
});

test('a real organisation gets a new key, with or without an empty body', async () => {
    for (const body of [undefined, {}]) {
        touched.length = 0;
        const res = await dispatch({ method: 'POST', url: '/admin/connector/tenants/org1/key', body });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(body));
        assert.ok(res.body.tenantKey && res.body.tenantKey !== 'the-live-key');
        assert.deepStrictEqual(touched.map((t) => t.what), ['setSecret', 'invalidateTenantKeyCache']);
    }
});

// ── DELETE: revoke ──────────────────────────────────────────────────

test('revoking under a mistyped org id is a 404, and the real key is untouched', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/admin/connector/tenants/org-1/key' });
    assert.strictEqual(res.statusCode, 404);
    assert.notStrictEqual(res.body.revoked, true);
    assert.deepStrictEqual(touched, []);
    assert.strictEqual(secrets.get('connector_tenant_key_org1'), 'the-live-key');
});

test('a real key is revoked', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/admin/connector/tenants/org1/key' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.revoked, true);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setSecret').args, ['connector_tenant_key_org1', '']);
});

test('a key whose organisation was deleted can still be revoked', async () => {
    // The org check is deliberately absent here: an orphaned key still
    // verifies connector tokens, and it is the one that most needs killing.
    secrets.set('connector_tenant_key_deleted-org', 'orphan-key');
    const res = await dispatch({ method: 'DELETE', url: '/admin/connector/tenants/deleted-org/key' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.revoked, true);
});
