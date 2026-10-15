'use strict';
/**
 * connectorJwtMiddleware: when auto-provisioning a new connector user fails for
 * a reason other than the seat cap, the request is refused with a 500 whose
 * body `error` is the old sentence (and `code: provision_failed`), through the
 * terminal handler, and never reaches the next handler.
 *
 * Run: cd server && node --test --test-force-exit auth/connectorJwt.provision.test.js
 */
process.env.NODE_ENV = 'test';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const signupGuards = require('./signupGuards');
const KEY = 'tenant-secret';
Object.assign(configStore, {
    listKeysWithPrefix: async () => ['connector_tenant_key_org1'],
    getSecret: async () => KEY,
    getSecretFresh: async () => KEY,
});
Object.assign(userStore, {
    getUserByEmail: async () => null,
    getOrganization: async () => ({ id: 'org1', nc_sync_mode: 'mirror_all', nc_instance_id: null }),
    createUserWithSeatCheck: async () => ({ ok: false, reason: 'db_error' }),
});
signupGuards.checkConnectorSignupAllowed = async () => ({ ok: true });
const connectorJwtMiddleware = require('./connectorJwt');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(payload) {
    const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
    return `${head}.${crypto.createHmac('sha256', KEY).update(head).digest('base64url')}`;
}

test('a failed auto-provision is 500 "Failed to provision user" and does not reach the handler', async () => {
    let reached = false;
    const app = express();
    app.use((req, _res, next) => { req.session = { regenerate: (cb) => cb() }; next(); });
    app.use(connectorJwtMiddleware);
    app.use((_req, res) => { reached = true; res.json({}); });
    app.use(terminalErrorHandler);
    const srv = app.listen(0, '127.0.0.1');
    after(() => { srv.closeAllConnections?.(); srv.close(); });
    await new Promise((r) => srv.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/x`, {
        headers: {
            'x-beeflow-source': 'nextcloud-connector',
            authorization: `Bearer ${token({ email: 'new@acme.example', sub: 'newuser' })}`,
        },
    });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error, 'Failed to provision user');
    assert.equal(body.code, 'provision_failed');
    assert.ok(body.correlationId);
    assert.equal(reached, false);
});
