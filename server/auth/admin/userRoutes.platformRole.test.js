/**
 * The platform role (`users.role === 'admin'`) on the user routes: only a
 * platform admin sets or clears it, a platform admin may step down, the last
 * account that can act as a platform admin keeps the role, stays active and is
 * not deleted (platformAdminCount.mts), and only a platform admin manages a
 * platform admin's account, also when it is a member of the caller's
 * organisation (orgAdminGuards.requireOrgAdminForUser).
 *
 * No module mocking: the router is served by testUtils/routeHarness over its
 * recording database seam, and the functions it calls through module objects
 * are swapped with testUtils/swaps. The ones userRoutes destructures when it is
 * loaded (loadConfig, the encryption calls, checkResourceLimits) are swapped
 * BEFORE it is required. The org-admin decision (_evalOrgAdmin) and the
 * password policy are the real ones.
 *
 * Run: cd server && node --test auth/admin/userRoutes.platformRole.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('../../testUtils/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');
const { PLATFORM_OPERATOR_ID } = require('../platformOperator');

const db = h.recordDb();
const permissions = require('../permissions');
const encryption = require('../encryption');
const limits = require('../../core/entitlements/limits');
const sessionCache = require('../sessionCache');
const userStore = require('../../stores/userStore');
const swaps = makeSwaps();

const fx = { users: [], groups: [], updates: [], deleted: [], created: [], keysRemoved: [] };

/** @type {import('express').RequestHandler} */
const needsSession = (req, res, next) => (req.session && req.session.isAuthenticated && req.session.user
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));
swaps.swap(permissions, 'requireAuth', needsSession);
swaps.swap(permissions, 'loadConfig', async () => ({ admin: { username: PLATFORM_OPERATOR_ID, passwordHash: 'set' } }));
swaps.swap(encryption, 'rewrapUserDEKCompat', async () => ({ success: true }));
swaps.swap(encryption, 'adminResetUser', async () => { });
swaps.swap(limits, 'checkResourceLimits', async () => null);
swaps.swap(sessionCache, 'bustSessionsForUser', async () => 0);

const copy = (v) => JSON.parse(JSON.stringify(v));
const api = h.serve('/', require('./userRoutes'), { user: { id: 'nobody', role: 'user' } });

test.before(async () => {
    await db.settle();
    swaps.swap(userStore, 'getUser', async (id) => copy(fx.users.find((u) => u.id === id) || null));
    swaps.swap(userStore, 'getAllUsers', async () => copy(fx.users));
    swaps.swap(userStore, 'getAllGroups', async () => copy(fx.groups));
    swaps.swap(userStore, 'getAllRoles', async () => []);
    swaps.swap(userStore, 'getAllOrganizations', async () => [{ id: 'orgA', name: 'Acme' }]);
    swaps.swap(userStore, 'updateUser', async (id, updates) => { fx.updates.push([id, updates]); return fx.users.some((u) => u.id === id); });
    swaps.swap(userStore, 'deleteUser', async (id) => { fx.deleted.push(id); return fx.users.some((u) => u.id === id); });
    swaps.swap(userStore, 'deleteAllSecurityKeys', async (id) => { fx.keysRemoved.push(id); return 0; });
    swaps.swap(userStore, 'createUserWithSeatCheck', async (u) => { fx.created.push(u); return { created: true }; });
    swaps.swap(userStore, 'logAccessAudit', async () => { });
});
test.after(async () => {
    swaps.restore();
    await api.close();
});

function resetFx({ operatorStatus = 'active' } = {}) {
    fx.groups = [{ id: 'g_a', name: 'Team', organizationId: 'orgA' }];
    fx.users = [
        { id: PLATFORM_OPERATOR_ID, username: PLATFORM_OPERATOR_ID, role: 'admin', status: operatorStatus },
        { id: 'ann', username: 'ann', role: 'admin', status: 'active' },
        { id: 'jan', username: 'jan', role: 'user', organizationId: 'orgA', groups: ['g_a'], orgRole: 'org_admin', status: 'active' },
        { id: 'eva', username: 'eva', role: 'user', organizationId: 'orgA', groups: ['g_a'], orgRole: 'member', status: 'active' },
    ];
    fx.updates.length = 0;
    fx.deleted.length = 0;
    fx.created.length = 0;
    fx.keysRemoved.length = 0;
    db.reset();
}
test.beforeEach(() => resetFx());

const ANN = { id: 'ann', role: 'admin' };
const JAN = { id: 'jan', role: 'user' };
/** @param {string} method @param {string} url @param {Record<string, unknown>} user @param {unknown} [body] */
const call = (method, url, user, body) => api.call(method, url, { user, body });

test('an organisation admin cannot make a member of their own organisation a platform admin', async () => {
    const res = await call('PUT', '/users/eva', JAN, { role: 'admin' });
    assert.equal(res.status, 403);
    assert.deepEqual(fx.updates, [], 'nothing is written');
});

test('nor create a platform admin in their own organisation', async () => {
    const res = await call('POST', '/users', JAN, { username: 'mole', displayName: 'Mole', password: 'Correct-Horse-Battery-42', organizationId: 'orgA', role: 'admin' });
    assert.equal(res.status, 403);
    assert.deepEqual(fx.created, []);
});

test('the unchanged role an organisation admin echoes back is accepted and not written', async () => {
    const res = await call('PUT', '/users/eva', JAN, { role: 'user', displayName: 'Eva' });
    assert.equal(res.status, 200, res.text);
    assert.equal(fx.updates[0][1].role, undefined);
});

test('a platform admin sets and clears the platform role', async () => {
    const on = await call('PUT', '/users/eva', ANN, { role: 'admin' });
    assert.equal(on.status, 200, on.text);
    assert.equal(fx.updates.at(-1)[1].role, 'admin');
    fx.users.find((u) => u.id === 'eva').role = 'admin';
    const off = await call('PUT', '/users/eva', ANN, { role: 'user' });
    assert.equal(off.status, 200, off.text);
    assert.equal(fx.updates.at(-1)[1].role, 'user');
});

test('a platform admin creates a platform admin', async () => {
    const res = await call('POST', '/users', ANN, { username: 'piet', displayName: 'Piet', password: 'Correct-Horse-Battery-42', role: 'admin' });
    assert.equal(res.status, 200, res.text);
    assert.equal(fx.created[0].role, 'admin');
});

test('a platform admin may step down while the operator account remains', async () => {
    const res = await call('PUT', '/users/ann', ANN, { role: 'user' });
    assert.equal(res.status, 200, res.text);
    assert.equal(fx.updates[0][1].role, 'user');
});

test('the last active platform admin cannot step down, be suspended or be deleted', async () => {
    resetFx({ operatorStatus: 'suspended' });
    for (const [method, url, body] of [['PUT', '/users/ann', { role: 'user' }], ['PUT', '/users/ann', { status: 'suspended' }], ['DELETE', '/users/ann', undefined]]) {
        const res = await call(method, url, ANN, body);
        assert.equal(res.status, 409, `${method} ${JSON.stringify(body)}`);
        assert.equal(res.body.code, 'last_platform_admin');
    }
    assert.deepEqual(fx.updates, []);
    assert.deepEqual(fx.deleted, []);
});

test('the operator account keeps its role, and is only suspended while another platform admin is active', async () => {
    const demote = await call('PUT', `/users/${PLATFORM_OPERATOR_ID}`, ANN, { role: 'user' });
    assert.equal(demote.status, 400);
    const suspend = await call('PUT', `/users/${PLATFORM_OPERATOR_ID}`, ANN, { status: 'suspended' });
    assert.equal(suspend.status, 200, suspend.text);

    resetFx();
    fx.users.find((u) => u.id === 'ann').role = 'user';
    const alone = await call('PUT', `/users/${PLATFORM_OPERATOR_ID}`, ANN, { status: 'suspended' });
    assert.equal(alone.status, 409);
    assert.equal(alone.body.code, 'last_platform_admin');
});

test('an account that is not a platform admin is never held back by the count', async () => {
    resetFx({ operatorStatus: 'suspended' });
    const res = await call('DELETE', '/users/eva', ANN);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(fx.deleted, ['eva']);
});

// ── A platform admin who is a member of the caller's organisation ──

const PIET = { id: 'piet', username: 'piet', role: 'admin', organizationId: 'orgA', groups: ['g_a'], orgRole: 'member', status: 'active', mfa_enabled: true };

/** Every write an organisation admin could aim at another member's account. */
const MEMBER_WRITES = [
    ['PUT', '/users/piet', { password: 'Attacker-Chosen-42-xyz' }],
    ['PUT', '/users/piet', { status: 'suspended' }],
    ['PUT', '/users/piet', { displayName: 'Renamed' }],
    ['POST', '/users/piet/mfa/reset', {}],
    ['DELETE', '/users/piet', undefined],
    ['DELETE', '/users/piet/avatar', undefined],
];

test('an organisation admin cannot set a password, reset two-factor, suspend, rename or delete a platform admin of their organisation', async () => {
    fx.users.push({ ...PIET });
    for (const [method, url, body] of MEMBER_WRITES) {
        const res = await call(method, url, JAN, body);
        assert.equal(res.status, 403, `${method} ${url} ${JSON.stringify(body)}: ${res.text}`);
        assert.equal(res.body.code, 'platform_admin_target');
    }
    assert.deepEqual(fx.updates, [], 'no account field is written');
    assert.deepEqual(fx.deleted, [], 'the account stays');
    assert.deepEqual(fx.keysRemoved, [], 'no security key is removed');
    assert.deepEqual(db.queries, [], 'the database is not reached');
});

test('the operator account is refused to an organisation admin in the same way', async () => {
    Object.assign(fx.users.find((u) => u.id === PLATFORM_OPERATOR_ID), { organizationId: 'orgA', groups: ['g_a'] });
    const res = await call('PUT', `/users/${PLATFORM_OPERATOR_ID}`, JAN, { password: 'Attacker-Chosen-42-xyz' });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body.code, 'platform_admin_target');
    assert.deepEqual(fx.updates, []);
});

test('the same organisation admin still manages an ordinary member', async () => {
    fx.users.push({ ...PIET });
    const res = await call('PUT', '/users/eva', JAN, { password: 'Correct-Horse-Battery-42' });
    assert.equal(res.status, 200, res.text);
    assert.ok(fx.updates[0][1].passwordHash, 'the hash is written');
});

test('a platform admin still manages that account', async () => {
    fx.users.push({ ...PIET });
    const put = await call('PUT', '/users/piet', ANN, { password: 'Correct-Horse-Battery-42' });
    assert.equal(put.status, 200, put.text);
    const mfa = await call('POST', '/users/piet/mfa/reset', ANN, {});
    assert.equal(mfa.status, 200, mfa.text);
    assert.equal(mfa.body.wasEnabled, true);
});
