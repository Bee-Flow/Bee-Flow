// @typecheck
/**
 * POST /reset-password against the real router and the real user store on
 * PGlite: the token in an e-mailed link resets the password ONCE. Two requests
 * carrying the same link cannot both succeed, and an expiry that is absent or
 * unreadable is an expired one.
 *
 * Run: cd server && node --test auth/login/passwordResetRoutes.consume.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('../../stores/user/schema');
const userStore = require('../../stores/userStore');
const passwords = require('../passwordHash');
const router = require('./passwordResetRoutes');
const { dispatcher } = require('../../testUtils/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: null }) });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HOUR = 60 * 60 * 1000;
const OLD_HASH = '$2b$10$old-hash';

before(async () => { await initDB(); });
after(close);

/** A password account holding a reset token; `expires` is the stored expiry (null for none). */
async function account(id, token, expires = new Date(Date.now() + HOUR)) {
    await pg.query(
        `INSERT INTO users (id, username, email, "passwordHash", "passwordResetRequired", password_reset_token_hash, password_reset_expires_at)
         VALUES ($1, $1, $2, $3, 1, $4, $5)`,
        [id, `${id}@example.test`, OLD_HASH, sha256(token), expires],
    );
}
const row = async (id) => (await pg.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
const reset = (token, newPassword) => dispatch({ method: 'POST', url: '/reset-password', body: { token, newPassword }, session: undefined });

test('a valid link sets the password, clears the token and dates the change', async () => {
    await account('anna', 'token-anna');
    const res = await reset('token-anna', 'Correct-Horse-Battery-9');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const u = await row('anna');
    assert.equal(await passwords.verify('Correct-Horse-Battery-9', u.passwordHash), true);
    assert.equal(u.password_reset_token_hash, null);
    assert.equal(u.password_reset_expires_at, null);
    assert.equal(u.passwordResetRequired, 0);
    assert.ok(u.password_changed_at, 'the new credential is dated');

    const again = await reset('token-anna', 'Another-Horse-Battery-7');
    assert.equal(again.statusCode, 400, 'the link is spent');
});

test('two requests with the same link: one resets the password, the other is refused', async () => {
    await account('ben', 'token-ben');
    const [a, b] = await Promise.all([
        reset('token-ben', 'First-Horse-Battery-1'),
        reset('token-ben', 'Second-Horse-Battery-2'),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 400]);
    const winner = a.statusCode === 200 ? 'First-Horse-Battery-1' : 'Second-Horse-Battery-2';
    const loser = a.statusCode === 200 ? 'Second-Horse-Battery-2' : 'First-Horse-Battery-1';
    const u = await row('ben');
    assert.equal(await passwords.verify(winner, u.passwordHash), true);
    assert.equal(await passwords.verify(loser, u.passwordHash), false, 'the refused request did not write its password');
});

test('the store consumes a token once, and never an expired one or another account\'s', async () => {
    await account('cleo', 'token-cleo');
    await account('dora', 'token-dora', new Date(Date.now() - 1000));
    assert.equal(await userStore.completePasswordReset('dora', sha256('token-dora'), 'h'), false, 'expired');
    assert.equal(await userStore.completePasswordReset('dora', sha256('token-cleo'), 'h'), false, 'not this account\'s token');
    const results = await Promise.all([1, 2, 3].map((n) => userStore.completePasswordReset('cleo', sha256('token-cleo'), `hash-${n}`)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await row('dora')).passwordHash, OLD_HASH);
});

test('a link whose expiry is missing or unreadable is expired', async (t) => {
    await account('emil', 'token-emil', null);
    assert.equal((await reset('token-emil', 'Correct-Horse-Battery-9')).statusCode, 400);

    await account('fay', 'token-fay');
    const real = userStore.getUserByPasswordResetToken;
    t.mock.method(userStore, 'getUserByPasswordResetToken', async (hash) => ({ ...(await real(hash)), password_reset_expires_at: 'not a date' }));
    const res = await reset('token-fay', 'Correct-Horse-Battery-9');
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'This reset link is invalid or has expired. Request a new one.');
    assert.equal((await row('fay')).passwordHash, OLD_HASH);
});
