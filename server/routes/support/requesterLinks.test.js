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
const Module = require('module');
const http = require('http');
const express = require('express');

const events = [];
const thread = { id: 'th-1', subject: 'S', status: 'open', requester_email: 'a@example.org', requester_user_id: null };
const tokens = require('../../stores/supportStore/requesterTokens');
const supportStore = {
    getThread: async (id) => (id === 'th-1' ? thread : null),
    getThreadMessages: async () => [],
    verifyAccessToken: tokens.verifyAccessToken,
    verifyCsatToken: tokens.verifyCsatToken,
    setCsat: async (p) => events.push(['csat', p]),
    confirmResolution: async () => {},
    disputeResolution: async () => events.push(['dispute']),
    recordThreadEvent: async () => {},
};
const pass = (_req, _res, next) => next();
const MOCKS = {
    '../../stores/supportStore': supportStore,
    '../../stores/userStore': { getUser: async () => null },
    '../../core/http/sseHelpers': { setupSSE: () => ({}), startSseHeartbeat: () => () => {} },
    '../../utils/appPaths': { clientHost: () => 'https://app.example' },
    '../../auth': { resolveUserOrgIds: async () => null },
    './shared': {
        _redactEmail: () => '', _shortId: (v) => String(v), _notifExcerpt: (v) => v, getUserId: () => null,
        getUserDisplay: () => null, _hasAdminSupport: async () => false, requireStaffSupport: pass,
        _csatHtml: ({ score, disputed, error } = {}) => `html:${error || (disputed ? 'disputed' : `score=${score}`)}`,
        supportEvents: { on() {}, off() {}, listenerCount: () => 0 },
        _emit: () => {}, _logListenerPressure: () => {}, notifyStaff: async () => {},
    },
    './rateLimits': { publicCreateLimiter: pass, threadReadLimiter: pass, _emailRateLimitOk: () => true },
    './threadCreate': {}, './threadHandlers': new Proxy({}, { get: () => pass }),
};
const ids = {};
for (const [k, v] of Object.entries(MOCKS)) {
    ids[k] = `mock:requester-links:${k}`;
    require.cache[ids[k]] = { id: ids[k], filename: ids[k], loaded: true, exports: v };
}
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /support[\\/](threads|satisfaction)\.js$/.test(parent.filename) && Object.hasOwn(ids, request)) return ids[request];
    return orig.call(this, request, parent, ...rest);
};
test.after(() => { Module._resolveFilename = orig; });

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
    assert.equal(await done.text(), 'html:score=4');
});

test('a CSAT dispute redirects tokenless too; a bad token is refused without redirect', async () => {
    const token = tokens.buildCsatToken('th-1', 'a@example.org', 0);
    const res = await get(`/api/support/csat/th-1?dispute=1&token=${token}`);
    assert.equal(res.status, 303);
    assert.ok(!res.headers.get('location').includes('token'));
    const bad = await get('/api/support/csat/th-1?score=4&token=bad');
    assert.equal(bad.status, 403);
});
