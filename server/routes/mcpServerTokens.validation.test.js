/**
 * What the MCP token routes accept, and what they say when they refuse
 * (routes/mcpServerTokens.js).
 *
 * The three routes act on the caller's own token and read nothing else, and
 * that used to be true in the worst way: a user id in the query or body fell
 * away and the route acted on the caller. `DELETE /token?userId=<colleague>`
 * revoked the ADMIN's token under `{ success: true }` and left the leaked one
 * working. What this file pins:
 *
 *   - a parameter is refused with a 400 that names where it was sent;
 *   - the message is a sentence;
 *   - the secret store is never reached, so a refused request rotates nothing;
 *   - a status read that fails is a 500, never `exists: false` — the app
 *     mints without its warning when it believes there is no token.
 *
 * Run: cd server && node --test routes/mcpServerTokens.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every secret-store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const secrets = new Map();
let storeDown = false; // the database is unreachable

const MOCKS = {
    '../stores/configStore': {
        getSecret: async (key) => {
            touched.push({ what: 'getSecret', args: [key] });
            if (storeDown) throw new Error('connection terminated unexpectedly');
            return secrets.get(key) ?? null;
        },
        setSecret: async (key, value) => { touched.push({ what: 'setSecret', args: [key, value] }); secrets.set(key, value); },
    },
    '../auth/mcpToken': {
        SECRET_KEY: (userId) => `mcp_server_token_user_${userId}`,
        mintToken: (userId) => ({ token: `bfmcp.${userId}.fresh`, random: 'fresh' }),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:mcp-server-tokens-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]mcpServerTokens\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./mcpServerTokens');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does. Quiet: one case below is a
// deliberate 500, and its log line is not the test's output.
const { createTerminalErrorHandler } = require('../core/http/terminalErrorHandler');
const terminalErrorHandler = createTerminalErrorHandler({ log: { warn() {}, error() {} } });

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { user: { id: 'admin1' } }, get() { return undefined; },
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

test.beforeEach(() => {
    touched.length = 0;
    storeDown = false;
    secrets.clear();
    secrets.set('mcp_server_token_user_admin1', 'admins-working-token');
    secrets.set('mcp_server_token_user_admin1_revoked', '0');
});

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.method} ${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.match(res.body.error, /your own MCP token/, 'the refusal says why, in a sentence');
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the secret store');
    assert.strictEqual(secrets.get('mcp_server_token_user_admin1'), 'admins-working-token',
        "the caller's own token is untouched");
    return res;
}

// ═══ DELETE /token ══════════════════════════════════════════════════

test("a colleague's id in the query of revoke is refused, not read as \"revoke mine\"", async () => {
    await refuses({ method: 'DELETE', url: '/token?userId=u2' }, 'query');
});

test("a colleague's id in the body of revoke is refused too", async () => {
    await refuses({ method: 'DELETE', url: '/token', body: { userId: 'u2' } }, 'body');
});

test('revoking the way the app does — no query, no body — still revokes the caller', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/token' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true });
    assert.strictEqual(secrets.get('mcp_server_token_user_admin1_revoked'), '1');
    assert.notStrictEqual(secrets.get('mcp_server_token_user_admin1'), 'admins-working-token');
});

// ═══ POST /token ════════════════════════════════════════════════════

test("minting \"for a colleague\" is refused rather than rotating away the caller's own token", async () => {
    await refuses({ method: 'POST', url: '/token', body: { userId: 'u2' } }, 'body');
});

test('an expiry nobody implements is refused rather than minting a token that never expires', async () => {
    await refuses({ method: 'POST', url: '/token', body: { expiresIn: '30d' } }, 'body');
});

test('a body that is not an object is refused in the same words', async () => {
    await refuses({ method: 'POST', url: '/token', body: ['u2'] }, 'body');
});

test('minting the way the app does — no body at all — still mints for the caller', async () => {
    const res = await dispatch({ method: 'POST', url: '/token' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.token, 'bfmcp.admin1.fresh');
    assert.strictEqual(secrets.get('mcp_server_token_user_admin1'), 'fresh');
    assert.strictEqual(secrets.get('mcp_server_token_user_admin1_revoked'), '0');
});

test('an empty JSON object is the same as no body', async () => {
    const res = await dispatch({ method: 'POST', url: '/token', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.token, 'bfmcp.admin1.fresh');
});

// ═══ GET /token ═════════════════════════════════════════════════════

test("asking whether a colleague holds a token is refused, not answered about the caller", async () => {
    await refuses({ method: 'GET', url: '/token?userId=u2' }, 'query');
});

test('the status read the app makes still answers', async () => {
    const res = await dispatch({ method: 'GET', url: '/token' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.exists, true);
    assert.strictEqual(res.body.transport, 'streamable_http');
});

test('a status read that fails is a 500, not "no token yet"', async () => {
    // The app answers `exists: false` with a Create button that mints at once;
    // only `exists: true` puts the "this revokes your client's token" warning
    // in front of it. A failed read must not be the first of those.
    storeDown = true;
    const res = await dispatch({ method: 'GET', url: '/token' });
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.exists, undefined, 'no answer about the token at all');
    assert.ok(res.body.correlationId, 'a correlation id the operator can find in the log');
});
