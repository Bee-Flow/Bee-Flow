'use strict';

/**
 * auth/login/finalizeLogin.js: the shared tail of a password login, gate by
 * gate.
 *
 *   - a suspended account is refused like a wrong password (401, the same
 *     body, padded to the failure floor, audited), with no exemption for an
 *     admin, and no session is made
 *   - an unverified account gets no session unless it is an admin
 *   - an account awaiting approval gets a restricted session and no key,
 *     unless it founded its organisation or is an admin; the second factor's
 *     session fields are not written on that exit
 *   - the key step: no key when encryption is off, a refusal when the key
 *     cannot be derived, the key on the session (and the recovery key in the
 *     answer once) when it can
 *
 * The collaborators are swapped on their module objects before the module
 * loads (it destructures them), as finalizeOpaqueLogin.test.js does.
 *
 * Run: cd server && node --test auth/login/finalizeLogin.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../testUtils/swaps');
const { REFUSAL } = require('../accountStatusGate');

const calls = { established: [], audits: [], padded: [], events: [], dekFor: [], encryptionAsked: [], created: [] };
const world = { encryptionEnabled: false, dek: null, adminRow: null };

const { swap, restore } = makeSwaps();
swap(require('../establishSession'), 'establishSession', async (_req, opts) => { calls.established.push(opts); });
swap(require('../loginAudit'), 'auditLoginBlocked', async (_req, entry) => { calls.audits.push(entry); });
swap(require('../loginThrottle'), 'padFailureResponse', async (startedAt) => { calls.padded.push(startedAt); });
swap(require('../../telemetry/metrics'), 'recordAuthEvent', (event) => { calls.events.push(event.status); });
swap(require('../../stores/encryptionAvailability'), 'isEncryptionEnabledForUser', async (userId) => {
    calls.encryptionAsked.push(userId);
    return world.encryptionEnabled;
});
swap(require('../encryption'), 'getOrCreateUserDEKCompat', async (userId, password) => {
    calls.dekFor.push({ userId, password });
    return world.dek;
});
swap(require('../permissions'), 'loadConfig', async () => ({ admin: { passwordHash: 'config-hash' } }));
const userStore = require('../../stores/userStore');
swap(userStore, 'getUser', async () => world.adminRow);
swap(userStore, 'createUser', async (row) => { calls.created.push(row); });
const { finalizeLogin, prepareLoginDek } = require('./finalizeLogin');
after(restore);

beforeEach(() => {
    for (const list of Object.values(calls)) list.length = 0;
    Object.assign(world, { encryptionEnabled: false, dek: null, adminRow: null });
});

function fakeReq() {
    return /** @type {any} */ ({ session: { save(cb) { cb(); } } });
}
function fakeRes() {
    return /** @type {any} */ ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
}

/** Run finalizeLogin for `stored` and return what it answered and wrote. */
async function login(stored, opts = {}) {
    const req = fakeReq();
    const res = fakeRes();
    await finalizeLogin(req, res, { user: { id: stored.id, displayName: 'Ann' }, isAdmin: false, storedUser: stored, password: 'pw', ...opts });
    return { req, res, session: calls.established[0] };
}

// ── Suspended ───────────────────────────────────────────────────────────

test('a suspended account is refused like a wrong password, padded, audited, and gets no session', async () => {
    const { res } = await login({ id: 'u1', status: 'suspended', organizationId: 'org-a' }, { startedAt: 1234 });
    assert.equal(res.statusCode, REFUSAL.status);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, REFUSAL.body);
    assert.equal(calls.established.length, 0);
    assert.deepEqual(calls.padded, [1234]);
    assert.deepEqual(calls.audits, [{ userId: 'u1', organizationId: 'org-a', method: 'password', reason: 'account_suspended' }]);
    assert.deepEqual(calls.events, ['blocked']);
    assert.equal(calls.dekFor.length, 0, 'no key is derived for a refused account');
});

test('suspension has no exemption: an admin and an org founder are refused too', async () => {
    for (const [stored, isAdmin] of [
        [{ id: 'u1', status: 'suspended', role: 'admin' }, true],
        [{ id: 'u2', status: 'suspended', orgRole: 'org_admin' }, false],
    ]) {
        calls.established.length = 0;
        const { res } = await login(stored, { isAdmin });
        assert.equal(res.statusCode, 401, stored.id);
        assert.equal(calls.established.length, 0, stored.id);
    }
});

test('a refusal without a start time from the caller is still padded', async () => {
    const before = Date.now();
    await login({ id: 'u1', status: 'suspended' });
    assert.equal(calls.padded.length, 1);
    assert.ok(calls.padded[0] >= before);
});

// ── Unverified ──────────────────────────────────────────────────────────

test('an unverified account gets no session, and the session is cleared, not established', async () => {
    const { req, res } = await login({ id: 'u1', status: 'unverified' }, { sessionExtra: { mfaVerifiedAt: 1 } });
    assert.deepEqual(res.body, { success: false, emailVerificationRequired: true });
    assert.equal(req.session.isAuthenticated, false);
    assert.equal(req.session.isAdmin, false);
    assert.equal(req.session.user, null);
    assert.equal(req.session.mfaVerifiedAt, undefined);
    assert.equal(calls.established.length, 0);
    assert.equal(calls.dekFor.length, 0);
});

test('an unverified admin is let through to a full session', async () => {
    const { res, session } = await login({ id: 'u1', status: 'unverified', role: 'admin' });
    assert.equal(res.body.success, true);
    assert.equal(session.extra.pendingApproval, undefined);
});

// ── Awaiting approval ───────────────────────────────────────────────────

test('an account on the waitlist or pending gets a restricted session, no key, and none of the second factor fields', async () => {
    for (const status of ['waitlist', 'pending']) {
        calls.established.length = 0;
        world.encryptionEnabled = true;
        world.dek = { encryptionKey: 'dek' };
        const { res, session } = await login({ id: 'u1', status, organizationId: 'org-a' }, { sessionExtra: { mfaVerifiedAt: 99 } });
        assert.deepEqual(session.extra, { pendingApproval: true }, status);
        assert.equal(session.audit.organizationId, 'org-a');
        assert.equal(res.body.pendingApproval, true);
        assert.equal(calls.dekFor.length, 0, `${status}: no key is derived before approval`);
    }
});

test('an org founder and an admin awaiting approval are not held back', async () => {
    for (const [stored, isAdmin] of [[{ id: 'u1', status: 'pending', orgRole: 'org_admin' }, false], [{ id: 'u2', status: 'waitlist' }, true]]) {
        calls.established.length = 0;
        const { res, session } = await login(stored, { isAdmin });
        assert.equal(res.body.pendingApproval, undefined, stored.id);
        assert.equal(session.extra.pendingApproval, undefined, stored.id);
    }
});

// ── The key step ────────────────────────────────────────────────────────

test('with encryption off the session carries no key, only the second factor fields', async () => {
    const { res, session } = await login({ id: 'u1', status: 'active' }, { isAdmin: true, sessionExtra: { mfaVerifiedAt: 7 } });
    assert.deepEqual(session.extra, { mfaVerifiedAt: 7 });
    assert.equal(session.isAdmin, true);
    assert.equal(session.user.isAdmin, true);
    assert.deepEqual(res.body, { success: true, user: { id: 'u1', displayName: 'Ann', isAdmin: true } });
    assert.deepEqual(calls.events, ['ok']);
});

test('a key that cannot be derived refuses the login and makes no session', async () => {
    world.encryptionEnabled = true;
    world.dek = null;
    const { res } = await login({ id: 'u1', status: 'active' });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Invalid credentials' });
    assert.equal(calls.established.length, 0);
    assert.deepEqual(calls.dekFor, [{ userId: 'u1', password: 'pw' }]);
});

test('a derived key goes on the session with the second factor fields; the recovery key only in the answer', async () => {
    world.encryptionEnabled = true;
    world.dek = { encryptionKey: 'dek-1', recoveryKey: 'rk-1' };
    const { res, session } = await login({ id: 'u1', status: 'active' }, { sessionExtra: { mfaVerifiedAt: 5 } });
    assert.deepEqual(session.extra, { encryptionKey: 'dek-1', mfaVerifiedAt: 5 });
    assert.equal(res.body.recoveryKey, 'rk-1');
    assert.equal(res.body.success, true);
});

test('no recovery key is answered when none was just made', async () => {
    world.encryptionEnabled = true;
    world.dek = { encryptionKey: 'dek-1' };
    const { res } = await login({ id: 'u1', status: 'active' });
    assert.equal('recoveryKey' in res.body, false);
});

test('a key already derived before the second factor is used as is, without the password', async () => {
    world.encryptionEnabled = true;
    const { session } = await login({ id: 'u1', status: 'active' }, { password: undefined, derived: { encryptionKey: 'parked' } });
    assert.equal(session.extra.encryptionKey, 'parked');
    assert.equal(calls.dekFor.length, 0);
    assert.equal(calls.encryptionAsked.length, 0);
});

test('a parked refusal (derived === false) still refuses', async () => {
    const { res } = await login({ id: 'u1', status: 'active' }, { password: undefined, derived: false });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.established.length, 0);
});

test('a parked "no encryption" (derived === null) makes a session without a key', async () => {
    world.encryptionEnabled = true;
    const { session } = await login({ id: 'u1', status: 'active' }, { password: undefined, derived: null });
    assert.equal(session.extra.encryptionKey, undefined);
    assert.equal(calls.dekFor.length, 0);
});

// ── prepareLoginDek ─────────────────────────────────────────────────────

test('prepareLoginDek answers null when encryption is off, false when the key fails, else the key', async () => {
    assert.equal(await prepareLoginDek({ id: 'u1' }, 'pw'), null);
    world.encryptionEnabled = true;
    assert.equal(await prepareLoginDek({ id: 'u1' }, 'pw'), false);
    world.dek = { encryptionKey: 'k', recoveryKey: undefined };
    assert.deepEqual(await prepareLoginDek({ id: 'u1' }, 'pw'), { encryptionKey: 'k' });
});

test('the platform operator gets a users row (from the config hash, dated as unchanged) before its key is made', async () => {
    world.encryptionEnabled = true;
    world.dek = { encryptionKey: 'k' };
    await prepareLoginDek({ id: 'admin' }, 'pw');
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].id, 'admin');
    assert.equal(calls.created[0].passwordHash, 'config-hash');
    assert.equal(calls.created[0].credentialUnchanged, true);

    calls.created.length = 0;
    world.adminRow = { id: 'admin' };
    await prepareLoginDek({ id: 'admin' }, 'pw');
    assert.equal(calls.created.length, 0, 'an existing row is left alone');

    world.adminRow = null;
    await prepareLoginDek({ id: 'someone' }, 'pw');
    assert.equal(calls.created.length, 0, 'only the operator gets a row made');
});
