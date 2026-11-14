'use strict';
/**
 * GET /auth/invite/:token is open: it names the invited address only masked.
 *
 * Run: cd server && node --test auth/login/inviteRoutes.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../testUtils/swaps');

const INVITATION = { id: 'inv1', email: 'alice.smith@acme.example', organization_id: 'org-a', role: 'user' };
const { swap, restore } = makeSwaps();
swap(require('../../stores/userStore'), 'getOrganization', async (id) => ({ id, name: 'Acme', logo: null }));
swap(require('../../stores/invitationStore'), 'getInvitationByToken', async (t) => (t === 'tok' ? INVITATION : null));
const router = require('./inviteRoutes');
test.after(restore);

function get(url) {
    return new Promise((resolve, reject) => {
        const req = { method: 'GET', url, originalUrl: url, path: url, query: {}, headers: {}, session: {}, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            setHeader() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through: ${url}`)));
    });
}

test('a valid token answers the organisation and a masked address, never the address itself', async () => {
    const res = await get('/invite/tok');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.orgName, 'Acme');
    assert.equal(res.body.email, undefined);
    assert.ok(!JSON.stringify(res.body).includes('alice.smith'), 'the local part does not appear');
    assert.match(res.body.emailHint, /^a.+h@acme\.example$/);
});

test('an unknown token is 410', async () => {
    const res = await get('/invite/nope');
    assert.equal(res.statusCode, 410);
});

test('clearing a pending invitation takes no fields: one sent is refused by name and the token stays', async () => {
    const { dispatcher } = require('../../testUtils/routeHarness');
    const session = { pendingInviteToken: 'tok', save(cb) { cb(); } };
    const res = await dispatcher(router, { session: () => session })({ method: 'POST', url: '/pending-invite/clear', body: { token: 'tok' } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /does not take "token"/);
    assert.equal(session.pendingInviteToken, 'tok');
    const cleared = await dispatcher(router, { session: () => session })({ method: 'POST', url: '/pending-invite/clear' });
    assert.equal(cleared.statusCode, 200);
    assert.equal(session.pendingInviteToken, undefined);
});

test('an invitation kept on the session answers its organisation, without handing the token back; one that no longer resolves is dropped', async () => {
    const { dispatcher } = require('../../testUtils/routeHarness');
    const invitationStore = require('../../stores/invitationStore');
    const pending = (/** @type {Record<string, unknown>} */ session) => dispatcher(router, { session: () => session })({ method: 'GET', url: '/pending-invite' });

    const kept = { pendingInviteToken: 'tok' };
    const res = await pending(kept);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.token, invitationStore.SESSION_INVITE_MARKER);
    assert.notEqual(res.body.token, 'tok');
    assert.deepEqual([res.body.organizationId, res.body.orgName, res.body.role], ['org-a', 'Acme', 'user']);
    assert.equal(kept.pendingInviteToken, 'tok', 'the entry stays for the sign-up that follows');

    const gone = { pendingInviteToken: 'revoked' };
    assert.deepEqual((await pending(gone)).body, { valid: false, error: 'Invitation expired or invalid' });
    assert.equal(gone.pendingInviteToken, undefined);

    assert.deepEqual((await pending({})).body, { valid: false });
});
