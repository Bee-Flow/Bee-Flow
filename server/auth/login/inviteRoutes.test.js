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
