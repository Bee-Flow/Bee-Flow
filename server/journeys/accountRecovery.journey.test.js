'use strict';

/**
 * Journey: a person takes their account back, and an admin takes access away.
 *
 * Recovery: a member is signed in on one device; on another they ask for a
 * reset link (the mail is the only thing recorded instead of sent), set a new
 * password with it, and from then on the old password is refused, the link
 * works once, the session that was open on the first device is signed out,
 * and the new password signs in.
 *
 * Suspension: the organisation admin suspends a colleague who is signed in;
 * the colleague's very next authenticated request is a 401, and signing in
 * again is refused.
 *
 * Run: cd server && npm run test:journeys
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld } = require('./journeyWorld.testkit');

const ORG = 'org-recovery';
const OLD_PW = 'Birch-tunnel-3381!';
const NEW_PW = 'Velvet-signal-7745!';
const ADMIN_PW = 'Amber-quarry-2209!';

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;
/** @type {(mail: any) => void} */
let resetMailed = () => {};
const resetMail = new Promise((resolve) => { resetMailed = resolve; });

before(async () => {
    world = await openWorld({ mounts: ['auth'] });
    await world.seedOrg({ id: ORG, name: 'Recovery org' });
    await world.seedUser({ id: 'rec-admin', password: ADMIN_PW, organizationId: ORG, orgRole: 'org_admin' });
    await world.seedUser({ id: 'rec-member', password: OLD_PW, organizationId: ORG, orgRole: 'member', email: 'rec-member@journey.test' });
    await world.seedUser({ id: 'rec-colleague', password: OLD_PW, organizationId: ORG, orgRole: 'member' });
    const emailService = require('../utils/emailService');
    world.swaps.swap(emailService, 'sendPasswordResetEmail', async (/** @type {any} */ mail) => { resetMailed(mail); return { success: true }; });
}, { timeout: 120_000 });

after(() => world?.close());

/** A request behind requireAuth: the caller's own entitlements. @param {import('./journeyWorld.testkit').Actor} a */
const authed = (a) => a.call('GET', '/auth/my-entitlements');

test('forgot password → mailed link → new password; the link works once, the old password and the open session are gone', { timeout: 60_000 }, async () => {
    const firstDevice = await world.login('rec-member', OLD_PW);
    assert.equal((await authed(firstDevice)).status, 200);

    const asked = await world.anonymous().call('POST', '/auth/forgot-password', { body: { email: 'rec-member@journey.test' } });
    assert.equal(asked.status, 200, asked.text);
    const unknown = await world.anonymous().call('POST', '/auth/forgot-password', { body: { email: 'nobody@journey.test' } });
    assert.deepEqual([unknown.status, unknown.body], [asked.status, asked.body], 'an unknown address gets the same answer');

    const mail = await resetMail;
    assert.equal(mail.email, 'rec-member@journey.test');
    const token = new URL(mail.resetUrl).searchParams.get('reset');
    assert.ok(token, mail.resetUrl);

    const reset = await world.anonymous().call('POST', '/auth/reset-password', { body: { token, newPassword: NEW_PW } });
    assert.equal(reset.status, 200, reset.text);
    const replay = await world.anonymous().call('POST', '/auth/reset-password', { body: { token, newPassword: 'Another-pass-9902!' } });
    assert.equal(replay.status, 400, 'a reset link works once');

    const old = await world.anonymous().call('POST', '/auth/admin-login', { body: { username: 'rec-member', password: OLD_PW } });
    assert.equal(old.status, 401, old.text);
    assert.equal((await authed(firstDevice)).status, 401, 'the session opened with the old password is signed out');
});

// The first sign-in gave this account an encryption key wrapped with the old
// password (auth/login/finalizeLogin.js prepareLoginDek). The reset makes the
// key follow the new password (auth/login/passwordResetKey.mts), so the sign-in
// that comes next is an ordinary one.
test('after the reset the new password signs in', { timeout: 60_000 }, async () => {
    const fresh = await world.login('rec-member', NEW_PW);
    assert.equal((await authed(fresh)).status, 200);
});

test('an admin suspends a signed-in colleague: their next request is a 401 and they cannot sign in again', { timeout: 60_000 }, async () => {
    const admin = await world.login('rec-admin', ADMIN_PW);
    const colleague = await world.login('rec-colleague', OLD_PW);
    assert.equal((await authed(colleague)).status, 200);

    const suspended = await admin.call('PUT', '/auth/users/rec-colleague', { body: { status: 'suspended' } });
    assert.equal(suspended.status, 200, suspended.text);

    assert.equal((await authed(colleague)).status, 401, 'the suspended colleague\'s open session no longer works');
    const again = await world.anonymous().call('POST', '/auth/admin-login', { body: { username: 'rec-colleague', password: OLD_PW } });
    assert.ok(again.status === 401 || again.status === 403, `signing in while suspended: ${again.status} ${again.text}`);
});
