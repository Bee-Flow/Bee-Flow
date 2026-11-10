'use strict';
/**
 * finalizeOpaqueLogin: an account awaiting approval gets the pendingApproval
 * flag on its session and in the answer, as the password path does; an
 * approved account and an exempt admin do not.
 *
 * Run: cd server && node --test auth/login/finalizeOpaqueLogin.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../testUtils/swaps');

/** @type {any[]} */
const established = [];
const { swap, restore } = makeSwaps();
swap(require('../establishSession'), 'establishSession', async (_req, opts) => { established.push(opts); });
const { finalizeOpaqueLogin } = require('./finalizeOpaqueLogin');
test.after(restore);

async function finalize(user) {
    established.length = 0;
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await finalizeOpaqueLogin(/** @type {any} */ ({ session: {} }), /** @type {any} */ (res), { user });
    return { res, extra: established[0]?.extra };
}

test('a pending or waitlisted account gets the pendingApproval flag', async () => {
    for (const status of ['pending', 'waitlist']) {
        const { res, extra } = await finalize({ id: 'u1', role: 'user', status });
        assert.equal(extra.pendingApproval, true, status);
        assert.equal(res.body.pendingApproval, true, status);
    }
});

test('an active account, an org founder and a platform admin get no flag', async () => {
    for (const user of [
        { id: 'u1', role: 'user', status: 'active' },
        { id: 'u2', role: 'user', status: 'pending', orgRole: 'org_admin' },
        { id: 'u3', role: 'admin', status: 'waitlist' },
    ]) {
        const { res, extra } = await finalize(user);
        assert.equal(extra.pendingApproval, undefined, user.id);
        assert.equal(res.body.pendingApproval, undefined, user.id);
    }
});

test('a suspended or inactive account gets the wrong-password answer and no session', async () => {
    for (const status of ['suspended', 'inactive']) {
        const { res, extra } = await finalize({ id: 'u1', role: 'admin', status });
        assert.equal(res.statusCode, 401, status);
        assert.deepEqual(res.body, { error: 'Invalid credentials' }, status);
        assert.equal(established.length, 0, status);
        assert.equal(extra, undefined, status);
    }
});
