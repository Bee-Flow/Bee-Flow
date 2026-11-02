/**
 * An invitation passes POST /pending-signup when ALLOW_SIGNUPS=false, as it
 * passes the password signup (auth/login/signupIntakeRoutes.js), and the
 * OAuth callback claims it for the provider's address (oauth/oauthInvite.mts).
 *
 * Run: cd server && node --test auth/login/signupIntakeRoutes.invite.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');

const invitations = new Map();
const claims = [];
const releases = [];
const { swap, restore } = makeSwaps();
swap(require('../../stores/userStore'), 'getAllOrganizations', async () => []);
swap(require('../../stores/configStore'), 'getConfig', async () => true);
swap(require('../signupGuards'), 'checkWebSignupAllowed', async () => ({ ok: false, status: 403, error: 'connector only', code: 'CONNECTOR_ONLY' }));
swap(require('../signupCaptcha'), 'verifyCaptcha', async () => ({ ok: true }));
const loginThrottle = require('../loginThrottle');
swap(loginThrottle, 'recordFanOut', async () => ({ delayMs: 0 }));
swap(loginThrottle, 'sleep', async () => {});
const invitationStore = require('../../stores/invitationStore');
swap(invitationStore, 'getInvitationByToken', async (token) => invitations.get(token) || null);
swap(invitationStore, 'markAccepted', async (token) => { if (claims.includes(token)) return false; claims.push(token); return true; });
swap(invitationStore, 'releaseClaim', async (id) => { releases.push(id); });

const router = require('./signupIntakeRoutes');
const { claimSessionInvite, releaseInvite } = require('../oauth/oauthInvite.mts');
const { dispatcher } = require('../../testUtils/routeHarness');

const dispatch = dispatcher(router);
const session = (extra = {}) => ({ save(cb) { cb(); }, ...extra });

test.before(() => { process.env.ALLOW_SIGNUPS = 'false'; });
test.after(() => { delete process.env.ALLOW_SIGNUPS; restore(); });
test.beforeEach(() => {
    invitations.clear(); claims.length = 0; releases.length = 0;
    invitations.set('tok-1', { id: 'inv-1', email: 'Ann@Acme.example', organization_id: 'acme' });
});

test('ALLOW_SIGNUPS=false still refuses an uninvited OAuth signup', async () => {
    const s = session();
    const res = await dispatch({ method: 'POST', url: '/pending-signup', body: { newOrgName: 'Acme' }, session: s });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(s.pendingSignup, undefined);
});

test('an invited address passes ALLOW_SIGNUPS=false and the connector-only gate', async () => {
    const s = session({ pendingInviteToken: 'tok-1' });
    const res = await dispatch({ method: 'POST', url: '/pending-signup', body: { inviteToken: 'session', newOrgName: 'Ignored' }, session: s });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(s.pendingSignup.invite, true);
    assert.strictEqual(s.pendingSignup.newOrgName, undefined, 'an invitation never founds an organisation');
});

test('the invite marker without a live invitation on the session is refused', async () => {
    const res = await dispatch({ method: 'POST', url: '/pending-signup', body: { inviteToken: 'session' }, session: session({ pendingInviteToken: 'gone' }) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_invite');
});

test('the callback claims the invitation only for the invited address, once', async () => {
    const s = { pendingInviteToken: 'tok-1' };
    assert.deepStrictEqual(await claimSessionInvite(s, 'mallory@evil.example'), { error: 'invite_email_mismatch' });
    const claim = await claimSessionInvite(s, 'ann@acme.example');
    assert.strictEqual(claim.inviteToken, 'tok-1');
    assert.deepStrictEqual(await claimSessionInvite(s, 'ann@acme.example'), { error: 'invite_used' });
    await releaseInvite(claim.inviteData);
    assert.deepStrictEqual(releases, ['inv-1']);
    assert.deepStrictEqual(await claimSessionInvite({}, 'ann@acme.example'), { error: 'invalid_invite' });
});
