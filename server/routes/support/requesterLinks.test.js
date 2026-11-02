/**
 * The mailed support links (thread `?token=`, CSAT `?token=`): the first use
 * trades the query token for a short-lived httpOnly cookie / a tokenless URL,
 * and every such response says no-referrer + no-store.
 *
 * Run: cd server && node --test routes/support/requesterLinks.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'x'.repeat(40);

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

process.env.CLIENT_PROTOCOL = 'https';
process.env.CLIENT_PUBLIC_HOST = 'app.example';

const events = [];
const thread = { id: 'th-1', subject: 'S', status: 'open', requester_email: 'a@example.org', requester_user_id: null, created_at: new Date().toISOString() };
const tokens = require('../../stores/supportStore/requesterTokens');
// The routes call the real store through its exports object, so the few
// methods they reach are swapped in place (and put back after the run).
const supportStore = require('../../stores/supportStore');
const stubs = {
    getThread: async (id) => (id === 'th-1' ? thread : null),
    getThreadMessages: async () => [],
    setCsat: async (p) => events.push(['csat', p]),
    confirmResolution: async () => {},
    disputeResolution: async () => events.push(['dispute']),
    recordThreadEvent: async () => {},
};
const originals = {};
for (const [k, v] of Object.entries(stubs)) { originals[k] = supportStore[k]; supportStore[k] = v; }
test.after(() => { Object.assign(supportStore, originals); });

const threads = require('./threads');
const satisfaction = require('./satisfaction');
const { cookieName, readCookieToken } = require('./requesterSession');

const router = express.Router();
threads.registerThreadRoutes(router);
satisfaction.register(router);
const app = express();
app.use('/api/support', router);

let server; let base;
test.before(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const get = (path, headers = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers });
const goodToken = () => tokens.buildAccessToken('th-1', 'a@example.org');

test('requesterSession reads only its own thread cookie', () => {
    assert.equal(cookieName('../x'), null);
    const req = { headers: { cookie: `a=1; ${cookieName('th-1')}=abc123; b=2` } };
    assert.equal(readCookieToken(req, 'th-1'), 'abc123');
    assert.equal(readCookieToken(req, 'th-2'), null);
});

test('GET /t/:id/open swaps the query token for an httpOnly Strict cookie and redirects without it', async () => {
    const token = goodToken();
    const res = await get(`/api/support/t/th-1/open?token=${token}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'https://app.example/support/t/th-1');
    assert.ok(!res.headers.get('location').includes(token));
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=3600/);
    assert.match(cookie, /Path=\/api\/support\/threads\/th-1/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('a wrong token gets the same 404 as an unknown thread and no cookie', async () => {
    for (const path of ['/api/support/t/th-1/open?token=nope', '/api/support/t/zzz/open?token=nope']) {
        const res = await get(path);
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('set-cookie'), null);
    }
});

test('the thread is readable by the cookie alone, and the query token still works (links already mailed)', async () => {
    const token = goodToken();
    const viaCookie = await get('/api/support/threads/th-1', { cookie: `${cookieName('th-1')}=${token}` });
    assert.equal(viaCookie.status, 200);
    assert.equal(viaCookie.headers.get('referrer-policy'), 'no-referrer');
    const viaQuery = await get(`/api/support/threads/th-1?token=${token}`);
    assert.equal(viaQuery.status, 200);
    assert.match(viaQuery.headers.get('set-cookie'), /HttpOnly/);
    const none = await get('/api/support/threads/th-1');
    assert.equal(none.status, 404);
    const forged = await get('/api/support/threads/th-1', { cookie: `${cookieName('th-1')}=deadbeef` });
    assert.equal(forged.status, 404);
});

test('a CSAT vote redirects to a URL without the token', async () => {
    const token = tokens.buildCsatToken('th-1', 'a@example.org', 4);
    const res = await get(`/api/support/csat/th-1?score=4&token=${token}`);
    assert.equal(res.status, 303);
    const loc = res.headers.get('location');
    assert.ok(!loc.includes(token) && !loc.includes('token'));
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const done = await get(loc);
    assert.equal(done.status, 200);
});

test('a CSAT dispute redirects tokenless too; a bad token is refused without redirect', async () => {
    const token = tokens.buildCsatToken('th-1', 'a@example.org', 0);
    const res = await get(`/api/support/csat/th-1?dispute=1&token=${token}`);
    assert.equal(res.status, 303);
    assert.ok(!res.headers.get('location').includes('token'));
    const bad = await get('/api/support/csat/th-1?score=4&token=bad');
    assert.equal(bad.status, 403);
});

test('an expired access token is the same 404 as a wrong one, in the query and in the cookie', async () => {
    const expired = tokens.buildAccessToken('th-1', 'a@example.org', { now: Date.now() - 31 * 24 * 60 * 60 * 1000 });
    assert.equal((await get(`/api/support/threads/th-1?token=${expired}`)).status, 404);
    assert.equal((await get(`/api/support/t/th-1/open?token=${expired}`)).status, 404);
    assert.equal((await get('/api/support/threads/th-1', { cookie: `${cookieName('th-1')}=${expired}` })).status, 404);
    const expiredVote = tokens.buildCsatToken('th-1', 'a@example.org', 4, { now: Date.now() - 31 * 24 * 60 * 60 * 1000 });
    assert.equal((await get(`/api/support/csat/th-1?score=4&token=${expiredVote}`)).status, 403);
});

test('a link mailed before tokens carried a date still opens a young thread, and not an old one', async () => {
    const crypto = require('node:crypto');
    const bare = crypto.createHmac('sha256', process.env.SESSION_SECRET).update('th-1:a@example.org').digest('hex').slice(0, 32);
    assert.equal((await get(`/api/support/threads/th-1?token=${bare}`)).status, 200);
    const was = thread.created_at;
    thread.created_at = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    try {
        assert.equal((await get(`/api/support/threads/th-1?token=${bare}`)).status, 404);
    } finally { thread.created_at = was; }
});
