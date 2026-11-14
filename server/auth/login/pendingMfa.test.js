'use strict';

/**
 * auth/login/pendingMfa.js: a first factor parked for the second.
 *
 *   - the parked login expires five minutes after it was parked, and the
 *     cookie is shortened to match
 *   - finishing it spends the parked blob BEFORE the session is made, so the
 *     same pending login cannot be finished twice
 *   - the password path is finished against the user row read after the
 *     second factor, not the snapshot taken at the first, so a status change
 *     in between (a suspension) is what the gates see
 *   - an OPAQUE login with a second factor parks without a session and does
 *     not answer the session key; without one it finishes at once
 *
 * The two finalizers are swapped on their module objects before this module
 * loads (it destructures them), as finalizeOpaqueLogin.test.js does.
 *
 * Run: cd server && node --test auth/login/pendingMfa.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../testUtils/swaps');

/** @type {{ kind: string, args: any, pendingAtCall: unknown }[]} */
const finalized = [];
const { swap, restore } = makeSwaps();
swap(require('./finalizeLogin'), 'finalizeLogin', async (req, res, args) => {
    finalized.push({ kind: 'password', args, pendingAtCall: req.session.mfaPending });
    return res.json({ success: true });
});
swap(require('./finalizeOpaqueLogin'), 'finalizeOpaqueLogin', async (req, res, args) => {
    finalized.push({ kind: 'opaque', args, pendingAtCall: req.session.mfaPending });
    return res.json({ success: true, ...(args.response || {}) });
});
const pendingMfa = require('./pendingMfa');
const { parkPendingLogin, isPendingLoginExpired, mfaMethodsFor, completePendingLogin, settleOpaqueFirstFactor, PENDING_MFA_TTL_MS, PENDING_EXPIRED } = pendingMfa;
after(restore);
beforeEach(() => { finalized.length = 0; });

function fakeReq(session = {}) {
    let saves = 0;
    const s = { cookie: { maxAge: 30 * 24 * 3600 * 1000 }, ...session, save(cb) { saves += 1; cb(); } };
    return { req: /** @type {any} */ ({ session: s }), saves: () => saves };
}
function fakeRes() {
    return /** @type {any} */ ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
}
const keysStore = (n) => ({ async listSecurityKeys() { return Array.from({ length: n }, (_, i) => ({ id: `k${i}` })); } });

// ── Expiry ──────────────────────────────────────────────────────────────

test('parking stamps the blob with the time and shortens the cookie to the pending lifetime', () => {
    const { req } = fakeReq();
    const before = Date.now();
    parkPendingLogin(req, { userId: 'u1' });
    assert.equal(req.session.mfaPending.userId, 'u1');
    assert.ok(req.session.mfaPending.pendingAt >= before && req.session.mfaPending.pendingAt <= Date.now());
    assert.equal(req.session.cookie.maxAge, PENDING_MFA_TTL_MS);
    assert.equal(PENDING_MFA_TTL_MS, 5 * 60 * 1000);
});

test('a session without a cookie object is parked without one', () => {
    const req = /** @type {any} */ ({ session: {} });
    parkPendingLogin(req, { userId: 'u1' });
    assert.equal(typeof req.session.mfaPending.pendingAt, 'number');
});

test('a parked login is live up to five minutes and expired one millisecond later', () => {
    const at = 1_000_000;
    assert.equal(isPendingLoginExpired({ pendingAt: at }, at), false);
    assert.equal(isPendingLoginExpired({ pendingAt: at }, at + PENDING_MFA_TTL_MS), false);
    assert.equal(isPendingLoginExpired({ pendingAt: at }, at + PENDING_MFA_TTL_MS + 1), true);
});

test('no parked login counts as expired', () => {
    assert.equal(isPendingLoginExpired(null), true);
    assert.equal(isPendingLoginExpired(undefined), true);
});

test('a blob without a numeric stamp is honoured, as parked before the stamp existed', () => {
    assert.equal(isPendingLoginExpired({}, Number.MAX_SAFE_INTEGER), false);
    assert.equal(isPendingLoginExpired({ pendingAt: '0' }, Number.MAX_SAFE_INTEGER), false);
});

test('the expired answer is a 401 with a code the client can act on', () => {
    assert.equal(PENDING_EXPIRED.status, 401);
    assert.equal(PENDING_EXPIRED.body.code, 'pending_login_expired');
    assert.ok(Object.isFrozen(PENDING_EXPIRED) && Object.isFrozen(PENDING_EXPIRED.body));
});

// ── Which second factors are offered ────────────────────────────────────

test('the methods offered follow what the account has: an app, keys, both, or neither', async () => {
    assert.deepEqual(await mfaMethodsFor(keysStore(0), { id: 'u', mfa_secret: 'enc' }), ['totp']);
    assert.deepEqual(await mfaMethodsFor(keysStore(2), { id: 'u', mfa_secret: null }), ['security_key']);
    assert.deepEqual(await mfaMethodsFor(keysStore(1), { id: 'u', mfa_secret: 'enc' }), ['totp', 'security_key']);
    assert.deepEqual(await mfaMethodsFor(keysStore(0), { id: 'u' }), []);
});

// ── Finishing a parked login ────────────────────────────────────────────

test('the password path spends the parked blob before it finalizes, so it cannot be finished twice', async () => {
    const { req } = fakeReq({ mfaPending: { userId: 'u1', user: { id: 'u1' }, isAdmin: false, derived: null, pendingAt: Date.now() } });
    const pending = req.session.mfaPending;
    await completePendingLogin(req, fakeRes(), { pending, userRow: { id: 'u1', status: 'active' }, startedAt: 123 });
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].pendingAtCall, undefined, 'the blob was still in the session when the session was made');
    assert.equal('mfaPending' in req.session, false);
});

test('the password path is finished against the row read now, with the parked key and a second-factor stamp', async () => {
    const parkedUser = { id: 'u1', displayName: 'Ann' };
    const freshRow = { id: 'u1', status: 'suspended' };
    const derived = { encryptionKey: 'dek' };
    const { req } = fakeReq({ mfaPending: {} });
    const before = Date.now();
    await completePendingLogin(req, fakeRes(), {
        pending: { user: parkedUser, isAdmin: true, password: undefined, derived },
        userRow: freshRow, startedAt: 42,
    });
    const { kind, args } = finalized[0];
    assert.equal(kind, 'password');
    assert.equal(args.storedUser, freshRow, 'the gates must see the row read after the second factor');
    assert.equal(args.user, parkedUser);
    assert.equal(args.isAdmin, true);
    assert.equal(args.derived, derived);
    assert.equal(args.startedAt, 42);
    assert.ok(args.sessionExtra.mfaVerifiedAt >= before);
});

test('an OPAQUE login is finished by the OPAQUE finalizer with the parked key, or none', async () => {
    const userRow = { id: 'u2' };
    const { req } = fakeReq({ mfaPending: {} });
    await completePendingLogin(req, fakeRes(), { pending: { opaque: true, encryptionKey: 'k2' }, userRow, startedAt: 1 });
    await completePendingLogin(req, fakeRes(), { pending: { opaque: true }, userRow, startedAt: 1 });
    assert.deepEqual(finalized.map((f) => f.kind), ['opaque', 'opaque']);
    assert.equal(finalized[0].args.user, userRow);
    assert.equal(finalized[0].args.encryptionKey, 'k2');
    assert.equal(finalized[1].args.encryptionKey, null);
    assert.equal(typeof finalized[0].args.sessionExtra.mfaVerifiedAt, 'number');
    assert.equal('mfaPending' in req.session, false);
});

// ── After an OPAQUE proof ───────────────────────────────────────────────

test('with a second factor, an OPAQUE proof parks the login and answers only the methods', async () => {
    const { req, saves } = fakeReq();
    const res = fakeRes();
    const user = { id: 'u3', displayName: 'Bo', role: 'admin', mfa_enabled: true, mfa_secret: 'enc', status: 'active' };
    await settleOpaqueFirstFactor(req, res, { user, encryptionKey: 'dek3', sessionKey: 'opaque-session-key', userStore: keysStore(0) });

    assert.equal(finalized.length, 0, 'no session before the second factor');
    assert.deepEqual(res.body, { mfaRequired: true, mfaMethods: ['totp'] });
    assert.equal(saves(), 1);
    const parked = req.session.mfaPending;
    assert.equal(parked.userId, 'u3');
    assert.equal(parked.opaque, true);
    assert.equal(parked.isAdmin, true);
    assert.equal(parked.encryptionKey, 'dek3');
    assert.equal(typeof parked.pendingAt, 'number');
    assert.equal(JSON.stringify(parked).includes('opaque-session-key'), false);
    assert.equal(parked.user.mfa_secret, undefined, 'only the session-user fields are parked');
    assert.equal(req.session.cookie.maxAge, PENDING_MFA_TTL_MS);
});

test('a parked OPAQUE login without a key carries no key field, and a non-admin role parks as not admin', async () => {
    const { req } = fakeReq();
    await settleOpaqueFirstFactor(req, fakeRes(), { user: { id: 'u4', mfa_enabled: true }, encryptionKey: null, sessionKey: 's', userStore: keysStore(1) });
    assert.equal('encryptionKey' in req.session.mfaPending, false);
    assert.equal(req.session.mfaPending.isAdmin, false);
    assert.equal(req.session.mfaPending.user.role, 'user');
});

test('without a second factor, an OPAQUE proof finishes at once and hands the client its session key', async () => {
    const { req } = fakeReq();
    const res = fakeRes();
    await settleOpaqueFirstFactor(req, res, { user: { id: 'u5', mfa_enabled: false }, encryptionKey: 'dek5', sessionKey: 'sk5', userStore: keysStore(0) });
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].args.encryptionKey, 'dek5');
    assert.deepEqual(finalized[0].args.response, { sessionKey: 'sk5' });
    assert.equal(typeof finalized[0].args.sessionExtra.opaqueLoginAt, 'number');
    assert.equal(req.session.mfaPending, undefined);
});
