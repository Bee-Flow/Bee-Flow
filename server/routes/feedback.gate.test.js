/**
 * Who is allowed to say an answer was wrong.
 *
 * `/api/feedback` used to be mounted behind the `advanced_usage_monitoring`
 * capability as a whole. That gate belongs on the routes that READ other
 * people's feedback; putting it on the mount also caught the POST, so a user
 * on any plan below enterprise got a 403 when they rated an answer. The one
 * channel by which a person could tell this product it had been wrong existed
 * only for the customers least likely to need it, and it failed silently —
 * the web client catches and logs.
 *
 * The two assertions here are the whole change: a denied capability must not
 * stop the POST, and must still stop each of the four admin reads.
 *
 * `requireSuperAdmin` and the org-admin check are stubbed open on purpose. They
 * run BEFORE the capability on every read (see the comment on
 * requireAdvancedMonitoring), and routes/feedback.authz.test.js is where that
 * ordering is pinned — this file is only about which routes carry the
 * entitlement at all.
 *
 * Run: cd server && node --test --test-force-exit routes/feedback.gate.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// The capability the mount used to carry, stubbed to REFUSE. Anything still
// sitting behind it answers 403; anything in front of it does not.
stub('../core/entitlements/entitlements', {
    requireCapability: () => (req, res) =>
        res.status(403).json({ error: 'capability required' }),
});

let saved = null;
stub('../stores/feedbackStore', {
    saveFeedback: async (row) => { saved = row; return { id: 'fb-1' }; },
    getFeedback: async () => [],
    getFeedbackSummary: async () => ({ up: 0, down: 0 }),
});
stub('../stores/userStore', { getUser: async () => ({ orgRole: 'org_admin' }) });
stub('../db', { getAll: async () => [] });
stub('../auth/permissions', {
    requireAuth: (req, res, next) => next(),
    requireSuperAdmin: (req, res, next) => next(),
    resolveUserOrgIds: async () => new Set(['org-1']),
    isOrgAdminRole: () => true,
});

const router = require('./feedback');
// The body schema refuses by handing an error to the terminal handler, so the
// harness answers one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body: body || {}, query: {},
            session: { user: { id: 'u-1' } },
            headers: {},
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            headersSent: false,
            headers: {},
            body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            getHeader(k) { return this.headers[String(k).toLowerCase()]; },
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

test('rating an answer does not need the advanced-monitoring capability', async () => {
    saved = null;
    const res = await dispatch({ method: 'POST', url: '/', body: { messageId: 'm1', rating: 'down' } });
    assert.notStrictEqual(res.statusCode, 403, 'POST / must not be gated on the capability');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(saved?.rating, 'down', 'the handler actually ran');
});

test('an invalid rating is still refused, capability or not', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { messageId: 'm1', rating: 'sideways' } });
    assert.strictEqual(res.statusCode, 400);
});

test('reading other people\'s feedback still needs the capability', async () => {
    for (const url of ['/', '/summary', '/org', '/org/summary']) {
        const res = await dispatch({ method: 'GET', url });
        assert.strictEqual(
            res.statusCode, 403,
            `GET ${url} must stay behind advanced_usage_monitoring`,
        );
    }
});
