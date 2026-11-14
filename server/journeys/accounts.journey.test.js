'use strict';

/**
 * Journey: an organisation admin brings a colleague in.
 *
 * The admin signs in, creates a member of their organisation, the member signs
 * in with the password they were given and sees themselves; a wrong password is
 * refused; signing out ends the session (the old cookie is a 401 afterwards).
 *
 * Run: cd server && npm run test:journeys (or node --test journeys/accounts.journey.test.js)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld } = require('./journeyWorld.testkit');

const ORG = 'org-accounts';
const ADMIN_PW = 'Lantern-orbit-4821!';
const MEMBER_PW = 'Quartz-meadow-7313!';

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;

before(async () => {
    world = await openWorld({ mounts: ['auth'] });
    await world.seedOrg({ id: ORG, name: 'Accounts org' });
    await world.seedUser({ id: 'acc-admin', password: ADMIN_PW, organizationId: ORG, orgRole: 'org_admin' });
}, { timeout: 120_000 });

after(() => world?.close());

test('admin creates a member, the member signs in, a wrong password is refused, sign-out ends the session', { timeout: 60_000 }, async () => {
    const admin = await world.login('acc-admin', ADMIN_PW);

    const created = await admin.call('POST', '/auth/users', {
        body: { username: 'acc-member', password: MEMBER_PW, displayName: 'Member One', email: 'member@journey.test', organizationId: ORG, orgRole: 'member' },
    });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.user.id, 'acc-member');

    const listed = await admin.call('GET', '/auth/users');
    assert.equal(listed.status, 200, listed.text);
    const users = Array.isArray(listed.body) ? listed.body : listed.body.users;
    assert.ok(users.some((/** @type {{ id: string }} */ u) => u.id === 'acc-member'), 'the new member is in the admin list');

    const wrong = await world.anonymous().call('POST', '/auth/admin-login', { body: { username: 'acc-member', password: 'not-the-password' } });
    assert.equal(wrong.status, 401, wrong.text);

    const member = await world.login('acc-member', MEMBER_PW);
    const me = await member.call('GET', '/auth/user');
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.authenticated, true);
    assert.equal(me.body.user.id, 'acc-member');
    assert.equal(me.body.user.displayName, 'Member One');

    // A member is not an organisation admin: creating users is refused.
    const notAdmin = await member.call('POST', '/auth/users', { body: { username: 'acc-intruder', password: MEMBER_PW, organizationId: ORG } });
    assert.equal(notAdmin.status, 403, notAdmin.text);

    const cookie = member.cookie();
    const out = await member.call('POST', '/auth/logout');
    assert.equal(out.status, 200, out.text);
    const replay = world.actor('replay', cookie);
    const after = await replay.call('GET', '/auth/user');
    assert.equal(after.body.authenticated, false, 'the old session cookie no longer signs anybody in');
});
