'use strict';
/**
 * connectorJwtMiddleware: when auto-provisioning a new connector user fails for
 * a reason other than the seat cap, the request is refused with a 500 whose
 * body `error` is the old sentence (and `code: provision_failed`), through the
 * terminal handler, and never reaches the next handler.
 *
 * And: one Nextcloud account has one user per organisation. A token whose
 * signed uid a user of the organisation holds signs in as that user, whatever
 * its address (the sync brings a new address over), and creates nobody.
 *
 * And: the id of a new user is `nc_<organisation>_<uid with dashes, cut to
 * 40>`; when that id is the row of another account, the id with a hash.
 *
 * Run: cd server && node --test --test-force-exit auth/connectorJwt.provision.test.js
 */
process.env.NODE_ENV = 'test';
const { test, after, beforeEach } = require('node:test');
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
/** @type {Array<Record<string, any>>} the users of the store stub */
let users = [];
/** @type {Array<Record<string, any>>} */
const creates = [];
let createAnswer = { created: false, reason: 'db_error' };
Object.assign(userStore, {
    getUserByEmail: async (email) => users.find(u => u.email === email) || null,
    getUserByNcUid: async (orgId, ncUid) => users.find(u => u.organizationId === orgId && u.nc_uid === ncUid) || null,
    getUser: async (id) => users.find(u => u.id === id) || null,
    getOrganization: async () => ({ id: 'org1', nc_sync_mode: 'mirror_all', nc_instance_id: null }),
    createUserWithSeatCheck: async (data) => {
        creates.push(data);
        if (createAnswer.created) users.push({ ...data, nc_uid: data.ncUid });
        return createAnswer;
    },
});
signupGuards.checkConnectorSignupAllowed = async () => ({ ok: true });
const connectorJwtMiddleware = require('./connectorJwt');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(payload) {
    // Every connector mint carries `exp`; the verifier requires it.
    const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 300, ...payload })}`;
    return `${head}.${crypto.createHmac('sha256', KEY).update(head).digest('base64url')}`;
}

let reached = false;
let srv;
async function signIn(payload) {
    if (!srv) {
        const app = express();
        app.use((req, _res, next) => { req.session = { regenerate: (cb) => cb() }; next(); });
        app.use(connectorJwtMiddleware);
        app.use((_req, res) => { reached = true; res.json({}); });
        app.use(terminalErrorHandler);
        srv = app.listen(0, '127.0.0.1');
        await new Promise((r) => srv.once('listening', r));
    }
    reached = false;
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/x`, {
        headers: { 'x-beeflow-source': 'nextcloud-connector', authorization: `Bearer ${token(payload)}` },
    });
    return { res, body: await res.json() };
}
after(() => { srv?.closeAllConnections?.(); srv?.close(); });
beforeEach(() => {
    users = [];
    creates.length = 0;
    createAnswer = { created: false, reason: 'db_error' };
});

test('a failed auto-provision is 500 "Failed to provision user" and does not reach the handler', async () => {
    const { res, body } = await signIn({ email: 'new@acme.example', sub: 'newuser' });
    assert.equal(res.status, 500);
    assert.equal(body.error, 'Failed to provision user');
    assert.equal(body.code, 'provision_failed');
    assert.ok(body.correlationId);
    assert.equal(reached, false);
});

// The row's id has the shape `nc_<org>_<uid with dashes>`.
for (const [id, uid] of [['nc_org1_john-doe', 'john.doe'], ['nc_org1_jdoe', 'jdoe'], ['nc_org1_a-b-nl', 'a@b.nl'], ['nc_org1_Jan-de-Vries', 'Jan de Vries']]) {
    test(`a token with a new address for uid "${uid}", which a user of the organisation holds: that user, nobody is created`, async () => {
        users = [{ id, email: 'old@acme.example', organizationId: 'org1', nc_uid: uid, provider: 'nextcloud_connector', status: 'active' }];
        createAnswer = { created: true };
        const { res } = await signIn({ email: 'new@acme.example', sub: uid });
        assert.equal(res.status, 200);
        assert.deepEqual(creates, []);
        assert.equal(users.length, 1);
        assert.equal(reached, true);
    });
}

test('the same uid held in another organisation does not stand in the way: the user is created', async () => {
    users = [{ id: 'nc_org2_john-doe', email: 'old@acme.example', organizationId: 'org2', nc_uid: 'john.doe' }];
    createAnswer = { created: true };
    const { res } = await signIn({ email: 'new@acme.example', sub: 'john.doe' });
    assert.equal(res.status, 200);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].ncUid, 'john.doe');
    assert.equal(creates[0].organizationId, 'org1');
    assert.equal(creates[0].id, 'nc_org1_john-doe');
    assert.equal(reached, true);
});

test('a new user gets the id nc_<organisation>_<uid with dashes, cut to 40>', async () => {
    createAnswer = { created: true };
    const uids = ['jdoe', 'john.doe', 'jane_roe', 'ann@acme.example', 'Jan de Vries', 'q'.repeat(64)];
    for (const [i, uid] of uids.entries()) {
        const { res } = await signIn({ email: `user${i}@acme.example`, sub: uid });
        assert.equal(res.status, 200, uid);
        assert.equal(creates[i].id, `nc_org1_${uid.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40)}`, uid);
    }
    assert.deepEqual(creates.map((u) => u.id), [
        'nc_org1_jdoe', 'nc_org1_john-doe', 'nc_org1_jane-roe', 'nc_org1_ann-acme-example', 'nc_org1_Jan-de-Vries', `nc_org1_${'q'.repeat(40)}`,
    ]);
});

test('john.doe then john_doe are two users: the second id carries a hash of its uid', async () => {
    createAnswer = { created: true };
    assert.equal((await signIn({ email: 'dot@acme.example', sub: 'john.doe' })).res.status, 200);
    assert.equal((await signIn({ email: 'underscore@acme.example', sub: 'john_doe' })).res.status, 200);
    const hash = crypto.createHash('sha256').update('john_doe').digest('hex').slice(0, 8);
    assert.deepEqual(creates.map((u) => [u.id, u.ncUid]), [['nc_org1_john-doe', 'john.doe'], [`nc_org1_john-doe-${hash}`, 'john_doe']]);
    assert.equal(users.length, 2);
});

test('both ids are rows of other accounts: 409 nc_user_id_conflict, nobody is created', async () => {
    const hash = crypto.createHash('sha256').update('john_doe').digest('hex').slice(0, 8);
    users = [
        { id: 'nc_org1_john-doe', email: 'dot@acme.example', organizationId: 'org1', nc_uid: 'john.doe' },
        { id: `nc_org1_john-doe-${hash}`, email: 'local@acme.example', organizationId: 'org1', provider: 'local' },
    ];
    createAnswer = { created: true };
    const { res, body } = await signIn({ email: 'underscore@acme.example', sub: 'john_doe' });
    assert.equal(res.status, 409);
    assert.equal(body.code, 'nc_user_id_conflict');
    assert.deepEqual(creates, []);
    assert.equal(reached, false);
});
