'use strict';
/**
 * A real router behind a real express app, for the `*.validation.test.js`
 * files that prove a refused request never reaches the store — without
 * reaching into the module system (`count-ratchet.mjs module-mock`).
 *
 * It lives beside validate() and the terminal error handler rather than in
 * testUtils/: it serves a router the way index.js does, through that handler,
 * and testUtils/ is platform, which may not require core (layering.test.js).
 *
 * Two seams, both on objects the product already shares:
 *
 *   - `db.pool`. Every store query goes through `pool.query` or
 *     `pool.connect`, so recording them is the proof that nothing was read or
 *     written. A query answers no rows unless the test says otherwise.
 *   - the gates exported by `auth/permissions` and re-exported by `auth`.
 *     Routes destructure them when they are required, so `openGates()` has to
 *     run BEFORE the router is required. The replacements check the session
 *     only: without one they still answer 401, so "the session is checked
 *     before the body" stays testable.
 *
 * Usage:
 *   const h = require('../core/http/routeHarness');
 *   const db = h.recordDb();
 *   h.openGates();
 *   const router = require('./templates');
 *   const api = h.serve('/api/templates', router);
 *   test.after(api.close);
 *   const res = await api.call('POST', '/api/templates', { body: { nme: 'x' } });
 *   assert.strictEqual(res.status, 400);
 *   assert.deepStrictEqual(db.queries, []);
 */

const http = require('node:http');
const express = require('express');

const USER = { id: 'u1', organizationId: 'org1', role: 'user', email: 'u1@example.test' };

// Schema bootstrap the stores run on their own, whenever they are first
// loaded or used: DDL, the transaction and lock plumbing around it, and the
// catalogue reads that decide whether a migration is needed. None of it is a
// request reaching a store, so `queries` leaves it out.
const BOOTSTRAP = /^\s*(CREATE|ALTER|DROP|COMMENT|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|DO\b)|pg_advisory|information_schema|pg_catalog|pg_extension|pg_indexes|to_regclass/i;

/**
 * Record every query instead of sending it. `answer(sql, params)` may return a
 * `{ rows }` result for the query; anything else answers no rows. `queries`
 * holds the ones that read or write data, `all` every statement.
 */
function recordDb(answer = () => undefined) {
    const db = require('../../db');
    const queries = [];
    const all = [];
    const query = async (sql, params) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        all.push(text);
        if (!BOOTSTRAP.test(text)) queries.push(text);
        const out = answer(text, params);
        return out ? { rowCount: (out.rows || []).length, ...out } : { rows: [], rowCount: 0 };
    };
    db.pool.query = query;
    db.pool.connect = async () => ({ query, release() {} });
    const reset = () => { queries.length = 0; all.length = 0; };
    /**
     * Stores that initialise when they are loaded keep querying for a while
     * after the router is required (schema, backfills). Wait until the
     * database has been quiet for `quietMs`, then forget what was recorded.
     */
    async function settle(quietMs = 150, maxMs = 10_000) {
        const start = Date.now();
        let seen = -1;
        while (seen !== all.length && Date.now() - start < maxMs) {
            seen = all.length;
            await new Promise((r) => setTimeout(r, quietMs));
        }
        reset();
    }
    return { queries, all, reset, settle };
}

const needsSession = (req, res, next) => {
    if (!req.session?.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    return next();
};

/**
 * Replace the session gates with session-only versions. `overrides` replaces
 * any other export of `auth/permissions` (and its `auth` re-export) by name.
 */
function openGates(overrides = {}) {
    const perms = require('../../auth/permissions');
    const auth = require('../../auth');
    const gates = {
        requireAuth: needsSession,
        requireAdmin: needsSession,
        requireSuperAdmin: needsSession,
        requireOrgAdmin: () => needsSession,
        requirePrimaryOrgAdmin: () => needsSession,
        requirePermission: () => needsSession,
        requirePluginAdmin: needsSession,
        requireActiveOrg: needsSession,
        requireActiveOrgForMutations: () => (req, res, next) => next(),
        hasPermission: async () => true,
        isSuperAdmin: () => false,
        ...overrides,
    };
    for (const [name, value] of Object.entries(gates)) {
        perms[name] = value;
        auth[name] = value;
    }
}

/**
 * Mount `router` at `path` behind the body parser index.js uses and the
 * terminal error handler, and listen on a free port. `call` sends a request
 * as `user` (default USER; `null` for no session).
 *
 * Also the whole app of a route test whose router takes its dependencies
 * injected (`serve('/', makeSharingRouter({ ... }))`, or an array of routers):
 * no gates or database to replace, a session user per call.
 */
function serve(path, router, { user = USER, session = {} } = {}) {
    const { terminalErrorHandler } = require('./terminalErrorHandler');
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use((req, _res, next) => {
        const who = req.headers['x-test-user'];
        const u = who === 'none' ? null : (who ? JSON.parse(who) : user);
        req.session = u
            ? { isAuthenticated: true, user: u, ...session, save: (cb) => cb && cb(), destroy: (cb) => cb && cb() }
            : { save: (cb) => cb && cb(), destroy: (cb) => cb && cb() };
        next();
    });
    app.use(path, router);
    app.use(terminalErrorHandler);
    const server = http.createServer(app);
    const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    async function call(method, url, { body, user: as, headers = {} } = {}) {
        await ready;
        const h = { ...headers };
        if (as !== undefined) h['x-test-user'] = as === null ? 'none' : JSON.stringify(as);
        let payload;
        if (body !== undefined) {
            h['content-type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: h, body: payload });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, body: json, text, headers: res.headers };
    }

    return {
        call,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

/** The shape every schema refusal has: a 400 naming the field, in a sentence. */
function assertRefused(assert, res, path, message) {
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    if (path) assert.ok(res.body.details.some((d) => d.path === path), `no issue at ${path}: ${JSON.stringify(res.body.details)}`);
    if (message) assert.match(res.body.error, message);
    assert.doesNotMatch(res.body.error, /^(Required$|Expected |Invalid enum value|Invalid input|Invalid type|Unrecognized key|String must|Number must|Array must)/, 'a zod default reached the client');
}

/**
 * The whole preamble of a validation test in one call: record the database,
 * open the gates (`gates: false` leaves them alone, an object overrides some),
 * THEN load the router — routes destructure the gates when they are required —
 * serve it, and wire the node:test hooks that settle and reset the recording.
 *
 *   const { db, api } = h.routeUnderTest(test, '/api/usage', () => require('./usage'));
 */
function routeUnderTest(test, path, load, { answer, gates = {}, ...serveOptions } = {}) {
    const db = recordDb(answer);
    if (gates !== false) openGates(gates);
    const api = serve(path, load(), serveOptions);
    test.before(() => db.settle());
    test.after(api.close);
    test.beforeEach(() => db.reset());
    return { db, api };
}

/**
 * In-process dispatch straight into a router, for the validation tests that
 * stub the stores behind it and need no listening socket: a fake req/res pair
 * goes through `router`, and an error it passes on is answered by the terminal
 * error handler the way index.js answers it. Resolves with the `res` (its
 * `statusCode` and `body`); a request no route handles rejects.
 *
 *   const dispatch = h.dispatcher(router, { session: () => ({ user: { id: 'u1' } }) });
 *   const res = await dispatch({ method: 'PUT', url: '/x?limit=5', body: {} });
 *
 * `session` builds the default session, a fresh one per call, because routes
 * write to it (login, MFA, signup); a call may pass its own. The query string
 * is parsed into `req.query`, and `req.path` is the url without it.
 */
function dispatcher(router, { session: makeSession = () => ({ user: { id: 'u1' } }) } = {}) {
    const { terminalErrorHandler } = require('./terminalErrorHandler');
    return function dispatch({ method, url, body = {}, session }) {
        return new Promise((resolve, reject) => {
            const [pathname, search = ''] = String(url).split('?');
            const query = {};
            for (const [k, v] of new URLSearchParams(search)) query[k] = v;
            const req = {
                method, url, originalUrl: url, path: pathname, query, body, headers: {},
                session: session || makeSession(), get() { return undefined; },
            };
            const res = {
                statusCode: 200, headersSent: false,
                set() { return this; }, setHeader() {}, cookie() { return this; },
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
    };
}

module.exports = { USER, recordDb, openGates, serve, routeUnderTest, assertRefused, dispatcher };
