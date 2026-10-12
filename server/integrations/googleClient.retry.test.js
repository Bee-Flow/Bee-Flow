'use strict';

/**
 * Google rate limits, against a real googleapis Gmail client and a local
 * HTTP server standing in for Google (no network, no DB).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
// Only the Gmail API: all of `googleapis` takes ~20 s to load.
const { gmail } = require('googleapis/build/src/apis/gmail');
const { OAuth2Client } = require('google-auth-library');
const { GOOGLE_RETRY_CONFIG, shouldRetryGoogleRequest, isRateLimitError } = require('./googleClient');

const rateLimited = { error: { code: 403, message: 'User rate limit exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } };
const forbidden = { error: { code: 403, message: 'Insufficient permission', errors: [{ reason: 'insufficientPermissions' }] } };

/** A server that answers from a script, then 200 {}, counting hits (token refreshes apart). */
async function fakeGoogle(script, { refreshToken = null } = {}) {
    const hits = [];
    const refreshes = [];
    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/token')) {
            refreshes.push(req.url);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'refreshed', expires_in: 3600 }));
            return;
        }
        hits.push(`${req.method} ${req.url.split('?')[0]}`);
        const step = script[hits.length - 1] || { status: 200, body: {} };
        res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers || {}) });
        res.end(JSON.stringify(step.body));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = new OAuth2Client({ clientId: 'id', clientSecret: 'secret', endpoints: { oauth2TokenUrl: `${base}/token` } });
    auth.setCredentials({ access_token: 'token', ...(refreshToken ? { refresh_token: refreshToken } : {}) });
    const client = gmail({ version: 'v1', auth, rootUrl: `${base}/`, retryConfig: { ...GOOGLE_RETRY_CONFIG } });
    return { client, hits, refreshes, close: () => new Promise(r => server.close(r)) };
}

const zero = { 'retry-after': '0' };

test('a rate-limit 403 is retried until Google lets the call through', async () => {
    const g = await fakeGoogle([{ status: 403, body: rateLimited, headers: zero }, { status: 403, body: rateLimited, headers: zero }]);
    try {
        const res = await g.client.users.labels.list({ userId: 'me' });
        assert.equal(res.status, 200);
        assert.equal(g.hits.length, 3);
    } finally { await g.close(); }
});

test('a mailbox that stays over its limit: four sends, no token refresh, and the error says 429', async () => {
    const limited = { status: 403, body: rateLimited, headers: zero };
    const g = await fakeGoogle(Array(10).fill(limited), { refreshToken: 'refresh' });
    try {
        await assert.rejects(g.client.users.labels.list({ userId: 'me' }), (e) => e.status === 429 && /User rate limit exceeded/.test(e.message));
        assert.equal(g.hits.length, 4, 'one send and three retries, not a second round after a refresh');
        assert.deepEqual(g.refreshes, [], 'a rate limit is not an expired token');
    } finally { await g.close(); }
});

test('a 403 that means "no access" is final at once', async () => {
    const g = await fakeGoogle([{ status: 403, body: forbidden }]);
    try {
        await assert.rejects(g.client.users.labels.list({ userId: 'me' }), /Insufficient permission/);
        assert.equal(g.hits.length, 1);
    } finally { await g.close(); }
});

test('a 429 is retried after its Retry-After; three retries, then the error stands', async () => {
    const tooMany = { status: 429, body: { error: { code: 429, message: 'Too many requests' } }, headers: zero };
    const g = await fakeGoogle([tooMany, tooMany, tooMany, tooMany, tooMany]);
    try {
        await assert.rejects(g.client.users.labels.list({ userId: 'me' }), /Too many requests/);
        assert.equal(g.hits.length, 4);
    } finally { await g.close(); }
});

test('a POST is never sent twice: an email must not go out again', async () => {
    const g = await fakeGoogle([{ status: 429, body: { error: { code: 429, message: 'Too many requests' } }, headers: zero }]);
    try {
        await assert.rejects(g.client.users.messages.send({ userId: 'me', requestBody: { raw: 'eA' } }), /Too many requests/);
        assert.deepEqual(g.hits, ['POST /gmail/v1/users/me/messages/send']);
    } finally { await g.close(); }
});

test('the decision rules on their own', () => {
    const err = (status, data, method = 'GET', attempt = 0) => ({ config: { method, retryConfig: { currentRetryAttempt: attempt } }, response: status ? { status, data } : undefined });
    assert.equal(shouldRetryGoogleRequest(err(403, rateLimited)), true);
    assert.equal(shouldRetryGoogleRequest(err(403, forbidden)), false);
    assert.equal(shouldRetryGoogleRequest(err(503, {})), true);
    assert.equal(shouldRetryGoogleRequest(err(404, {})), false);
    assert.equal(shouldRetryGoogleRequest(err(429, {}, 'POST')), false);
    assert.equal(shouldRetryGoogleRequest(err(429, {}, 'GET', 3)), false);
    assert.equal(shouldRetryGoogleRequest(err(0, null, 'GET', 1)), true, 'a network error gets two tries');
    assert.equal(shouldRetryGoogleRequest(err(0, null, 'GET', 2)), false);
    assert.equal(shouldRetryGoogleRequest({ code: 'AbortError', config: { method: 'GET' } }), false);
    assert.equal(isRateLimitError({ error: { status: 'RESOURCE_EXHAUSTED' } }), true);
    assert.equal(isRateLimitError('nope'), false);
});
