'use strict';
/**
 * Connector sign-in by the signed Nextcloud uid, and the one-time link of an
 * existing account after a normal sign-in.
 *
 *   - A token whose uid no member holds, with the address of an organisation
 *     administrator who has a password and no stored uid: 409
 *     nc_link_required, no session, the stored uid stays empty.
 *   - The stored uid of a connector-created account cannot be checked: the
 *     sign-in is refused and the stored uid stays.
 *   - The link page redeems the ticket from that 409 only for the same
 *     account, signed in within the last minutes; it then writes the uid
 *     once, and the next connector sign-in finds the account by that uid.
 *
 * Run: cd server && node --test auth/connectorJwt.linkRequired.test.js
 */
process.env.NODE_ENV = 'test';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const encryption = require('./encryption');
const orgHealth = require('../services/orgHealth');
const log = require('../telemetry/log');
const serviceDeps = require('./connector/serviceDeps');
const connectorJwtMiddleware = require('./connectorJwt');
const phases = require('./connectorJwtPhases');
const { redeemLinkTicket, verifyLinkTicket } = require('./connector/ncLinkTicket.mts');

const ORG = 'org1';
const KEY = 'tenant-secret-link';
const ADMIN_EMAIL = 'boss@acme.example';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(payload) {
    const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 300, ...payload })}`;
    return `${head}.${crypto.createHmac('sha256', KEY).update(head).digest('base64url')}`;
}

let users;
let updates;
let seq = 0;
const savedHost = process.env.CLIENT_PUBLIC_HOST;
const savedState = serviceDeps.storedUidState;
after(() => {
    if (savedHost === undefined) delete process.env.CLIENT_PUBLIC_HOST; else process.env.CLIENT_PUBLIC_HOST = savedHost;
    serviceDeps.storedUidState = savedState;
});

beforeEach(() => {
    process.env.CLIENT_PUBLIC_HOST = 'app.acme.example';
    connectorJwtMiddleware.invalidateTenantKeyCache();
    phases._linkDeps.hasSsoIdentity = async () => false;
    serviceDeps.storedUidState = async () => 'unknown';
    updates = [];
    users = [{
        id: `admin${++seq}`, email: ADMIN_EMAIL, organizationId: ORG, role: 'user', orgRole: 'org_admin',
        passwordHash: 'argon2-hash', nc_uid: null, provider: null, status: 'active',
    }];
    Object.assign(configStore, {
        listKeysWithPrefix: async () => [`connector_tenant_key_${ORG}`],
        getSecret: async () => KEY,
        getSecretFresh: async () => KEY,
    });
    Object.assign(userStore, {
        getUser: async (id) => users.find((u) => u.id === id) || null,
        getUserByEmail: async (email) => users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null,
        getUserByNcUid: async (org, uid) => users.find((u) => u.organizationId === org && u.nc_uid === uid) || null,
        getOrganization: async (id) => ({ id, nc_instance_id: 'nc1', nc_onboarding_completed_at: 1, nc_base_url: 'https://cloud.acme.example' }),
        updateUser: async (id, u) => { updates.push([id, u]); },
        createUserWithSeatCheck: async () => { throw new Error('nobody is created here'); },
        setNcUidIfUnchanged: async (id, org, uid, expected) => {
            const row = users.find((u) => u.id === id && u.organizationId === org);
            if (!row || (row.nc_uid || '') !== expected || users.some((u) => u.id !== id && u.organizationId === org && u.nc_uid === uid)) return false;
            row.nc_uid = uid;
            return true;
        },
    });
    Object.assign(encryption, {
        getOrCreateSSOUserDEKCompat: async () => ({ encryptionKey: 'k' }),
        getFallbackEncryptionKey: () => 'f',
    });
    orgHealth.problem = () => {};
    orgHealth.event = () => {};
    orgHealth.touchLiveness = () => {};
    log.warn = () => {};
    log.info = () => {};
});

async function signIn(payload) {
    const req = {
        method: 'GET', url: '/x', ip: '9.9.9.9',
        headers: { 'x-beeflow-source': 'nextcloud-connector', authorization: `Bearer ${token(payload)}` },
        session: { regenerate: (cb) => cb() },
    };
    const out = { status: undefined, body: undefined, next: 0 };
    const res = { status(n) { out.status = n; return res; }, json(b) { out.body = b; return res; }, setHeader() { return res; } };
    req.res = res;
    await connectorJwtMiddleware(req, res, () => { out.next += 1; });
    return { ...out, req };
}

const ticketOf = (linkUrl) => decodeURIComponent(linkUrl.split('#nc_link=')[1]);

test('another Nextcloud uid with an administrator\'s address: 409 nc_link_required, no session, the stored uid stays empty', async () => {
    const out = await signIn({ sub: 'someone', email: ADMIN_EMAIL });
    assert.equal(out.status, 409);
    assert.equal(out.body.code, 'nc_link_required');
    assert.equal(out.next, 0);
    assert.notEqual(out.req.session.isAuthenticated, true);
    assert.equal(out.req.session.encryptionKey, undefined);
    assert.deepEqual(updates, []);
    assert.equal(users[0].nc_uid, null);
    const claims = verifyLinkTicket(ticketOf(out.body.linkUrl));
    assert.deepEqual({ ...claims, expiresAt: 0 }, { userId: users[0].id, orgId: ORG, ncUid: 'someone', storedUid: '', ncHost: 'cloud.acme.example', expiresAt: 0 });
});

test('a connector-created account whose stored uid cannot be checked: refused, the stored uid stays', async () => {
    users[0] = { ...users[0], passwordHash: null, orgRole: 'agent_editor', provider: 'nextcloud_connector', nc_uid: 'first' };
    const out = await signIn({ sub: 'second', email: ADMIN_EMAIL });
    assert.equal(out.status, 503);
    assert.equal(out.body.code, 'nc_uid_unverified');
    assert.deepEqual(updates, []);
    assert.equal(users[0].nc_uid, 'first');
});

test('the link is redeemed by the same account after a recent sign-in, once; then the uid signs in', async () => {
    const { body } = await signIn({ sub: 'boss', email: ADMIN_EMAIL });
    const ticket = ticketOf(body.linkUrl);
    const id = users[0].id;
    const fresh = { isAuthenticated: true, user: { id, organizationId: ORG }, authenticatedAt: Date.now() };

    assert.deepEqual(await redeemLinkTicket({ ...fresh, user: { id: 'other', organizationId: ORG } }, ticket), { error: 'nc_link_other_account', status: 403 });
    assert.deepEqual(await redeemLinkTicket({ ...fresh, authenticatedAt: Date.now() - 60 * 60_000 }, ticket), { error: 'reauth_required', status: 403 });
    assert.deepEqual(await redeemLinkTicket({ isAuthenticated: false }, ticket), { error: 'reauth_required', status: 403 });
    assert.deepEqual(await redeemLinkTicket(fresh, `${ticket}x`), { error: 'nc_link_invalid', status: 400 });
    assert.equal(users[0].nc_uid, null);

    assert.deepEqual(await redeemLinkTicket(fresh, ticket), { linked: true, ncUid: 'boss' });
    assert.equal(users[0].nc_uid, 'boss');

    const out = await signIn({ sub: 'boss', email: ADMIN_EMAIL });
    assert.equal(out.next, 1);
    assert.equal(out.req.session.user.id, id);

    // Relinked elsewhere since: the old ticket no longer matches.
    users[0].nc_uid = 'later';
    assert.deepEqual(await redeemLinkTicket(fresh, ticket), { error: 'nc_link_stale', status: 409 });
    assert.equal(users[0].nc_uid, 'later');
});

test('a uid another member holds is never moved by a link', async () => {
    const { body } = await signIn({ sub: 'boss', email: ADMIN_EMAIL });
    users.push({ id: 'holder', email: 'h@acme.example', organizationId: ORG, nc_uid: 'boss', provider: 'nextcloud_connector' });
    const fresh = { isAuthenticated: true, user: { id: users[0].id }, authenticatedAt: Date.now() };
    assert.deepEqual(await redeemLinkTicket(fresh, ticketOf(body.linkUrl)), { error: 'nc_link_stale', status: 409 });
    assert.equal(users[0].nc_uid, null);
});

test('an expired ticket is refused', async () => {
    process.env.NC_LINK_TICKET_TTL_SECONDS = '60';
    try {
        const { body } = await signIn({ sub: 'boss', email: ADMIN_EMAIL });
        const claims = verifyLinkTicket(ticketOf(body.linkUrl));
        assert.equal(verifyLinkTicket(ticketOf(body.linkUrl), claims.expiresAt + 1), null);
    } finally { delete process.env.NC_LINK_TICKET_TTL_SECONDS; }
});
