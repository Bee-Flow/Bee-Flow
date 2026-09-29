/**
 * What the notification routes accept, and what they say when they refuse
 * (routes/notifications.js).
 *
 * The list read `?unread` by exact match and `?limit` with parseInt, so neither
 * could fail: `?unread=1` returned the READ notifications too, `?limit=-1`
 * became a 500 from Postgres, `?limit=abc` became 50 and `?limit=1e3` became 1.
 * And the two POSTs ignored their body, so `{ read: false }` marked a
 * notification READ. What this file pins:
 *
 *   - both query spellings the clients send (`true`, and numbers) still work;
 *   - anything else is a 400 that names the parameter, in a sentence;
 *   - a refused request never reaches the store;
 *   - an anonymous caller still gets the 401 first.
 *
 * Run: cd server && node --test routes/notifications.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../stores/notificationStore': {
        getNotifications: async (userId, opts) => { touched.push({ what: 'getNotifications', args: [userId, opts] }); return []; },
        getUnreadCount: async () => 0,
        markAllRead: async (userId) => { touched.push({ what: 'markAllRead', args: [userId] }); return 2; },
        markRead: async (id, userId) => { touched.push({ what: 'markRead', args: [id, userId] }); return true; },
        deleteNotification: async () => true,
    },
    '../db': { pool: { query: async () => ({ rows: [{}], rowCount: 1 }) } },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:notifications-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]notifications\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./notifications');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body, session = { user: { id: 'u1' } } }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const list = (query, session) => dispatch({ method: 'GET', url: '/', query, session });
const UNREAD_TEXT = "unread is 'true' or 'false'.";
const LIMIT_TEXT = 'limit is a whole number of notifications, 1 or more.';

test.beforeEach(() => { touched.length = 0; });

test('what the app and the web client send still works', async () => {
    // mobile: ?unread=true&limit=20 — the web client: ?limit=30
    await list({ unread: 'true', limit: '20' });
    await list({ limit: '30' });
    await list({});
    assert.deepStrictEqual(touched.map((t) => t.args[1]), [
        { unreadOnly: true, limit: 20 },
        { unreadOnly: false, limit: 30 },
        { unreadOnly: false, limit: 50 },
    ]);
});

test('?unread=1 is read as yes, not as "everything"', async () => {
    const res = await list({ unread: '1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].args[1].unreadOnly, true);
});

test('an unread value that is not a yes or a no is refused in a sentence', async () => {
    const res = await list({ unread: 'yes' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, UNREAD_TEXT);
    assert.ok(res.body.details.some((d) => d.path === 'query.unread'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled filter is refused by name, instead of returning everything', async () => {
    const res = await list({ unraed: 'true' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/unraed/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('a negative limit is a 400, not a 500 from Postgres', async () => {
    const res = await list({ limit: '-1' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, LIMIT_TEXT);
    assert.deepStrictEqual(touched, []);
});

test('a limit that is not a whole number is refused, not replaced', async () => {
    for (const limit of ['abc', '0', '2.5', '']) {
        const res = await list({ limit });
        assert.strictEqual(res.statusCode, 400, limit);
        assert.strictEqual(res.body.error, LIMIT_TEXT);
    }
    assert.deepStrictEqual(touched, []);
});

test('?limit=1e3 means a thousand, not one', async () => {
    await list({ limit: '1e3' });
    assert.strictEqual(touched[0].args[1].limit, 1000);
});

test('marking one read takes no body — { read: false } is refused, not read as "mark read"', async () => {
    const res = await dispatch({ method: 'POST', url: '/n1/read', body: { read: false } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
    const ok = await dispatch({ method: 'POST', url: '/n1/read', body: undefined });
    assert.strictEqual(ok.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'markRead', args: ['n1', 'u1'] }]);
});

test('read-all takes no body — a filter it would ignore is refused', async () => {
    const res = await dispatch({ method: 'POST', url: '/read-all', body: { category: 'task' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/category/.test(res.body.error), res.body.error);
    assert.deepStrictEqual(touched, []);
});

test('an anonymous caller gets the 401 before anything about the request is read', async () => {
    const res = await list({ limit: '-1' }, {});
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: 'Not authenticated' });
});
