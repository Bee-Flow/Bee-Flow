// @typecheck
/**
 * POST /api/license/activate and the admin-issued blob (`beeflow-admin-v1.…`),
 * against the real router and the real licence store on PGlite.
 *
 * A blob carries no signature, so whoever may activate one can hand
 * themselves any tier. Only a platform super-admin may, in every scope; an
 * org admin and a person without an organisation are refused and nothing is
 * stored. A signed key keeps working for all of them.
 *
 * routes/license.serverScope.test.js holds the same rule against a stand-in
 * licence module; this file runs the real one, so "nothing is stored" is read
 * from the table.
 *
 * Run: cd server && node --test routes/license.adminBlob.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const license = require('../license');
const { encodeAdminLicenseBlob, BLOB_PREFIX } = require('../license/adminIssuance');
const { initDB: initUsers } = require('../stores/user/schema');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
const router = require('./license');

const SUPER = { isAuthenticated: true, isAdmin: true, user: { id: 'root', organizationId: 'org-acme', role: 'admin' } };
const ORG_ADMIN = { isAuthenticated: true, isAdmin: false, user: { id: 'olga', organizationId: 'org-acme', role: 'user', orgRole: 'admin' } };
const LONER = { isAuthenticated: true, isAdmin: false, user: { id: 'lone', organizationId: null, role: 'user' } };

const YEAR = 365 * 24 * 60 * 60 * 1000;
const blob = () => encodeAdminLicenseBlob({
    v: 1, tier: 'enterprise', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + YEAR).toISOString(),
    billing_interval: 'yearly', metadata: {},
});

let session = null;
let server;
let base;

before(async () => {
    await initUsers();
    await pg.query(`INSERT INTO organizations (id, name) VALUES ('org-acme', 'Acme')`);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = session; next(); });
    app.use('/api/license', router);
    app.use(terminalErrorHandler);
    await new Promise((resolve) => { server = app.listen(0, () => resolve(undefined)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await close();
});
beforeEach(async () => { await pg.query('DELETE FROM license_keys'); });

function activate(as, body) {
    session = as;
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}/api/license/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (r) => {
            let text = '';
            r.on('data', (c) => { text += c; });
            r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}
const stored = async () => (await pg.query('SELECT scope, organization_id, user_id, tier FROM license_keys')).rows;

test('an org admin cannot activate an admin blob, in any scope, and nothing is stored', async () => {
    for (const scope of [undefined, 'organization', 'consumer', 'server']) {
        const res = await activate(ORG_ADMIN, { token: blob(), ...(scope ? { scope } : {}) });
        assert.equal(res.status, 403, `scope ${scope}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.code, scope === 'server' ? undefined : 'admin_blob_super_admin_only');
    }
    assert.deepEqual(await stored(), []);
});

test('a person without an organisation cannot activate an admin blob for themselves', async () => {
    for (const scope of [undefined, 'consumer']) {
        const res = await activate(LONER, { token: blob(), ...(scope ? { scope } : {}) });
        assert.equal(res.status, 403, JSON.stringify(res.body));
        assert.equal(res.body.code, 'admin_blob_super_admin_only');
    }
    assert.deepEqual(await stored(), []);
});

test('a super-admin activates an admin blob', async () => {
    const res = await activate(SUPER, { token: blob() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.activated.tier, 'enterprise');
    assert.deepEqual(await stored(), [{ scope: 'organization', organization_id: 'org-acme', user_id: null, tier: 'enterprise' }]);
});

test('an org admin still activates a signed key', async (t) => {
    const now = Math.floor(Date.now() / 1000);
    t.mock.method(license.verify, 'verifyToken', async () => ({
        valid: true,
        payload: { license_id: 'lic-signed-1', tier: 'enterprise', iss: 'license.beeflow.test', sub: 'org-acme', iat: now, exp: now + 3600 },
    }));
    const res = await activate(ORG_ADMIN, { token: 'eyJhbGciOiJFZERTQSJ9.payload.signature' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await stored(), [{ scope: 'organization', organization_id: 'org-acme', user_id: null, tier: 'enterprise' }]);
});

test('the licence module itself refuses a blob nobody vouched for, whatever the scope', async () => {
    for (const args of [{ organizationId: 'org-acme' }, { userId: 'lone' }, { scope: 'server' }]) {
        await assert.rejects(() => license.activateLicense({ token: blob(), ...args }), (e) => /** @type {{ code?: string }} */ (e).code === 'admin_blob_super_admin_only');
    }
    assert.ok(blob().startsWith(BLOB_PREFIX));
    assert.deepEqual(await stored(), []);
});
