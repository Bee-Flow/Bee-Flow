/**
 * POST /ai/firebird/test (routes/ai/config/firebirdTestRoute.js): tries the form's
 * unsaved values, falls back to the stored secrets, answers in one shape and
 * never echoes the password.
 *
 * Run: cd server && node --test routes/ai/config/integrations.firebirdTest.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const stored = {};
/** @type {any[]} */
const attempts = [];
let outcome = { ok: true, server_version: 'LI-V4.0.2', table_count: 412 };

const express = require('express');
const { createFirebirdTestRouter } = require('./firebirdTestRoute');

// The route takes its collaborators as parameters; the session gate is a pass-through here,
// so the handler's own "no user in the session -> 401" check is what answers an anonymous call.
const router = createFirebirdTestRouter({
    requireAuth: (_req, _res, next) => next(),
    getSecret: async (k) => stored[k] || null,
    testConnection: async (creds) => {
        attempts.push(creds);
        if (outcome instanceof Error) throw outcome;
        return outcome;
    },
});

let server;
let baseUrl;
test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid) req.session = { isAuthenticated: true, user: { id: uid, role: 'user' } };
        next();
    });
    app.use('/ai', router);
    app.use((err, _req, res, _next) => res.status(Number(err?.status) || 500).json({ error: err.message, details: err.details }));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((resolve) => server.close(resolve)); });

async function call(body, user = 'u1') {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const res = await fetch(`${baseUrl}/ai/firebird/test`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    return { status: res.status, json: await res.json().catch(() => null) };
}

const FORM = { firebirdHost: 'db.internal', firebirdDatabase: 'C:\\Data\\Atrium.fdb', firebirdUser: 'READER', firebirdPassword: 'hunter2-secret' };

test.beforeEach(() => {
    attempts.length = 0;
    for (const k of Object.keys(stored)) delete stored[k];
    outcome = { ok: true, server_version: 'LI-V4.0.2', table_count: 412 };
});

test('needs a signed-in user', async () => {
    const r = await call(FORM, null);
    assert.strictEqual(r.status, 401);
    assert.strictEqual(attempts.length, 0);
});

test('unsaved form values are tried and answered in one shape', async () => {
    const r = await call({ ...FORM, firebirdPort: 3051, firebirdCharset: 'WIN1252' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true, server_version: 'LI-V4.0.2', table_count: 412 });
    assert.deepStrictEqual(attempts[0], {
        host: 'db.internal', port: '3051', database: 'C:\\Data\\Atrium.fdb', user: 'READER', password: 'hunter2-secret', charset: 'WIN1252',
    });
});

test('values left out fall back to the stored secrets of the caller', async () => {
    Object.assign(stored, {
        firebird_host_user_u1: 'stored.internal', firebird_database_user_u1: 'atrium', firebird_user_user_u1: 'STORED', firebird_password_user_u1: 'pw',
        firebird_host_user_u2: 'other.internal',
    });
    const r = await call({ firebirdDatabase: 'override' });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(attempts[0].host, 'stored.internal');
    assert.strictEqual(attempts[0].database, 'override');
});

test('nothing typed and nothing stored says not configured, without trying', async () => {
    const r = await call({});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, false);
    assert.match(r.json.error, /not configured/);
    assert.strictEqual(attempts.length, 0);
});

test('a refused connection is { ok: false, error } and the password never travels back', async () => {
    outcome = { ok: false, error: 'db.internal:3050 refused hunter2-secret' };
    const r = await call(FORM);
    assert.strictEqual(r.json.ok, false);
    assert.ok(!JSON.stringify(r.json).includes('hunter2-secret'));
    outcome = new Error('boom hunter2-secret');
    const r2 = await call(FORM);
    assert.strictEqual(r2.json.ok, false);
    assert.ok(!JSON.stringify(r2.json).includes('hunter2-secret'));
});

test('a host with a scheme is refused by the same schema as Save', async () => {
    const r = await call({ ...FORM, firebirdHost: 'tcp://db.internal' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(attempts.length, 0);
});
