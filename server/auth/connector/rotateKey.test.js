/**
 * POST /auth/connector/rotate-key: the connector's "Rotate tenant key" button.
 *
 * Re-bootstrapping never rotated anything (a known instance id always gets
 * its existing key back), so a suspected-leaked key stayed valid while the
 * admin was told it had been replaced. This route really replaces it.
 *
 * The real router and the real tenant resolver (connectorJwt) run; only the
 * config store is an in-memory map.
 *
 * Run: cd server && node --test auth/connector/rotateKey.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const configStore = require('../../stores/configStore');
const userStore = require('../../stores/userStore');
const { _resolveTenant, invalidateTenantKeyCache } = require('../connectorJwt');

const PREFIX = 'connector_tenant_key_';
const OLD_KEY = 'old-tenant-key-for-org1-32-bytes-xx';
/** @type {Record<string, string | null>} */
let secrets = {};
const audits = [];

configStore.listKeysWithPrefix = async (prefix) => Object.keys(secrets).filter((k) => k.startsWith(prefix) && secrets[k]);
configStore.getSecret = async (k) => secrets[k] || null;
configStore.getSecretFresh = async (k) => secrets[k] || null;
configStore.setSecret = async (k, v) => { secrets[k] = v || null; };
userStore.logAccessAudit = async (...args) => { audits.push(args); };

const router = require('../connectorBootstrap');

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 */
function mintToken(payload, key) {
    const enc = (/** @type {unknown} */ obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const h = enc({ alg: 'HS256', typ: 'JWT' });
    const p = enc({ iss: 'nextcloud-connector', aud: 'beeflow.nl', exp: Math.floor(Date.now() / 1000) + 60, ...payload });
    const sig = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
}

const rotateToken = (key = OLD_KEY, extra = {}) => mintToken({ purpose: 'connector:rotate-tenant-key', ...extra }, key);

/** @param {string | null} token */
async function rotate(token) {
    const app = express();
    app.use('/auth', router);
    const server = app.listen(0);
    try {
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        const res = await fetch(`http://127.0.0.1:${port}/auth/connector/rotate-key`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

test.beforeEach(() => {
    secrets = { [`${PREFIX}org1`]: OLD_KEY };
    audits.length = 0;
    invalidateTenantKeyCache();
});

test('a rotation answers a new key, stores it, and the old key no longer verifies', async () => {
    const oldUserToken = mintToken({ sub: 'alice', email: 'alice@nc.test' }, OLD_KEY);
    assert.equal((await _resolveTenant(oldUserToken))?.orgId, 'org1');

    const { status, body } = await rotate(rotateToken());
    assert.equal(status, 200);
    assert.equal(body.organizationId, 'org1');
    assert.equal(typeof body.tenantKey, 'string');
    assert.notEqual(body.tenantKey, OLD_KEY);
    assert.equal(secrets[`${PREFIX}org1`], body.tenantKey);

    assert.equal(await _resolveTenant(oldUserToken), null, 'a token signed with the old key is rejected');
    const newUserToken = mintToken({ sub: 'alice', email: 'alice@nc.test' }, body.tenantKey);
    assert.equal((await _resolveTenant(newUserToken))?.orgId, 'org1');
    assert.equal(audits.length, 1);
    assert.equal(audits[0][0], 'connector_tenant_key_rotated');
});

test('a per-user token (no rotation purpose) cannot rotate the key', async () => {
    const { status, body } = await rotate(mintToken({ sub: 'alice', email: 'alice@nc.test' }, OLD_KEY));
    assert.equal(status, 403);
    assert.equal(body.code, 'wrong_token_purpose');
    assert.equal(secrets[`${PREFIX}org1`], OLD_KEY);
});

test('a long-lived rotation token is refused', async () => {
    const { status } = await rotate(rotateToken(OLD_KEY, { exp: Math.floor(Date.now() / 1000) + 3600 }));
    assert.equal(status, 401);
    assert.equal(secrets[`${PREFIX}org1`], OLD_KEY);
});

test('an unknown key or no token rotates nothing', async () => {
    assert.equal((await rotate(rotateToken('some-other-key-not-a-tenant-key-xx'))).status, 401);
    assert.equal((await rotate(null)).status, 401);
    assert.equal(secrets[`${PREFIX}org1`], OLD_KEY);
    assert.equal(audits.length, 0);
});
