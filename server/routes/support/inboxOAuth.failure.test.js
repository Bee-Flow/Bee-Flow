'use strict';

/**
 * routes/support/inboxOAuth.js: when a mailbox connect fails, the popup page
 * carries a fixed sentence, not the error's own text. The cause (a provider's
 * token answer, a database error) belongs in the log; an HttpError is the one
 * kind of error whose sentence was written for the client.
 *
 * Run: cd server && node --test routes/support/inboxOAuth.failure.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// stores/supportInboxStore derives its token key from this when it loads.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'inbox-oauth-test-session-secret-0123456789abcdef';

// The stores this router loads initialise against the shared pool: record, do not connect.
require('../../testUtils/routeHarness').recordDb();

const emailService = require('../../utils/emailService');
const { HttpError } = require('../../core/http/errors');
const { oauthCallback } = require('./inboxOAuth');

const realComplete = emailService.completeOAuthConnect;
afterEach(() => { emailService.completeOAuthConnect = realComplete; });

/** A callback request of the platform Service Email connect, with a session that started it. */
function serviceEmailCallback() {
    return {
        query: { code: 'c0de', state: 'st4te' },
        session: { serviceEmailConnect: { state: 'st4te', redirectUri: 'https://beeflow.test/api/support-inbox/oauth/callback' }, save: (cb) => cb() },
        headers: {}, protocol: 'https', get: () => 'beeflow.test',
    };
}

function makeRes() {
    const res = { statusCode: 200, body: '' };
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (body) => { res.body = String(body); return res; };
    return res;
}

test('a failed token exchange: 500, and the provider\'s answer is not in the page', async () => {
    emailService.completeOAuthConnect = async () => { throw new Error('token endpoint answered 401: {"error":"invalid_client","error_description":"The OAuth client was not found."}'); };
    const req = serviceEmailCallback();
    const res = makeRes();
    await oauthCallback(req, res);
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(res.body, /invalid_client|OAuth client|token endpoint/);
    assert.match(res.body, /could not be connected/);
    assert.equal(req.session.serviceEmailConnect, undefined, 'the connect session is spent');
});

test('an error written for the client keeps its own sentence', async () => {
    emailService.completeOAuthConnect = async () => { throw new HttpError(400, 'mailbox_mismatch', 'Sign in with the address this mailbox was set up for.'); };
    const res = makeRes();
    await oauthCallback(serviceEmailCallback(), res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /Sign in with the address this mailbox was set up for\./);
});
