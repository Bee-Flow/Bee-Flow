/**
 * What the connections API accepts, and what it says when it refuses
 * (routes/integrations/connections.js). The wiring and the org-isolation
 * rules are covered by connections.test.js; this file pins the shapes.
 *
 * Four keys here were read in a way that turned a caller's mistake into a
 * 200 over the wrong outcome, and two of them are the SAME key read two
 * different ways in one file:
 *
 *   - POST `makeDefault: !!makeDefault` made the string 'false' mean TRUE,
 *     so a connection created with the default toggle off became the org
 *     default; PATCH `makeDefault === true` made the string 'true' mean
 *     nothing at all, and answered 200 with the re-read connection, which
 *     the UI renders as "saved".
 *   - PATCH `typeof label === 'string'` skipped a label of the wrong JSON
 *     type in silence, so the rename box reverted on the next reload.
 *   - GET `?includeShared=true` returned the caller's OWN connections only,
 *     which a client cannot tell from "nothing is lent to you".
 *   - DELETE `?force=true` kept answering 409 "Connection is shared".
 *
 * And `resourceType` was checked on POST /:id/grants but NOT on the two
 * reads, so a typo there narrowed the answer to nothing instead of failing.
 *
 * Run: cd server && node --test routes/integrations/connections.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const CONN = { id: 'c-1', ownerUserId: 'u1', orgId: 'orgA', provider: 'slack', kind: 'api_key', label: 'Work', secretMeta: {} };

const MOCKS = {
    '../../stores/integrationConnectionStore': {
        resolveOrgId: (o) => (o && String(o).trim()) || '__default_org__',
        listConnectionsForUser: async () => [],
        listAccessibleConnections: async (a) => { touched.push({ what: 'listAccessible', args: [a] }); return []; },
        listGrants: async (f) => { touched.push({ what: 'listGrants', args: [f] }); return []; },
        getGrant: async () => null,
        revokeGrant: async () => true,
        getConnection: async () => ({ ...CONN }),
        createConnection: async (a) => { touched.push({ what: 'createConnection', args: [a] }); return { ...CONN, ...a }; },
        renameConnection: async (id, label) => { touched.push({ what: 'renameConnection', args: [id, label] }); },
        updateConnectionSecret: async (...a) => { touched.push({ what: 'updateSecret', args: a }); },
        updateConnectionMeta: async (...a) => { touched.push({ what: 'updateMeta', args: a }); },
        setDefault: async (id) => { touched.push({ what: 'setDefault', args: [id] }); },
        deleteConnection: async (id) => { touched.push({ what: 'deleteConnection', args: [id] }); return true; },
        shareConnection: async (a) => { touched.push({ what: 'shareConnection', args: [a] }); return { id: 'g-1', ...a }; },
        resolveConnectionForRun: async (a) => { touched.push({ what: 'resolveForRun', args: [a] }); return { mode: 'byo_required', available: false }; },
        _internals: { OAUTH_AUTOMATION_PROVIDERS: new Set(['google']) },
    },
    '../../stores/userStore': {
        getUser: async (id) => ({ id, organizationId: 'orgA', email: `${id}@acme.test`, groups: [] }),
        getUserByEmail: async () => null,
        getAllGroups: async () => [],
        logAccessAudit: async () => {},
    },
    '../../auth/permissions': { requireActiveOrgForMutations: () => pass, requireAuth: pass },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    // Lazily required inside GET /required. Without a stub it pulls the real
    // store layer in and every run opens a database connection it cannot use.
    '../../appStudio/mailboxIdentity': { viewerHasIntegration: async () => false },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-connections-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]connections\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./connections');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'u1' }, isAuthenticated: true }, get() { return undefined; },
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

test.beforeEach(() => { touched.length = 0; });

// ── The two flags that meant their opposite ─────────────────────────

test("?includeShared=true now adds the lent connections instead of dropping them", async () => {
    const res = await dispatch({ method: 'GET', url: '/', query: { provider: 'http', includeShared: 'true' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'listAccessible'), 'the lent listing was actually consulted');
});

test('?includeShared=1 keeps working exactly as before', async () => {
    const res = await dispatch({ method: 'GET', url: '/', query: { provider: 'http', includeShared: '1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'listAccessible').args[0].provider, 'http');
});

test('an includeShared value nobody can read is refused, not quietly ignored', async () => {
    const res = await dispatch({ method: 'GET', url: '/', query: { provider: 'http', includeShared: 'yes' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'includeShared is 1 or 0.');
    assert.deepStrictEqual(touched, []);
});

test('?force=true now deletes a shared connection instead of answering 409 forever', async () => {
    MOCKS['../../stores/integrationConnectionStore'].listGrants = async () => [{ id: 'g-x' }];
    const res = await dispatch({ method: 'DELETE', url: '/c-1', query: { force: 'true' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deleted, true);
    MOCKS['../../stores/integrationConnectionStore'].listGrants = async (f) => { touched.push({ what: 'listGrants', args: [f] }); return []; };
});

test('a force value nobody can read is refused, instead of silently meaning "no"', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/c-1', query: { force: 'yes' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'force is 1 or 0.');
    assert.deepStrictEqual(touched, []);
});

// ── makeDefault: one key, two rules ─────────────────────────────────

test("POST makeDefault: 'false' no longer makes the connection the default", async () => {
    const res = await dispatch({
        method: 'POST', url: '/',
        body: { provider: 'slack', kind: 'api_key', secret: { api_key: 'x' }, makeDefault: 'false' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'makeDefault is true or false.');
    assert.deepStrictEqual(touched, [], 'no connection was created');
});

test("PATCH makeDefault: 'true' is refused instead of answering 200 and doing nothing", async () => {
    const res = await dispatch({ method: 'PATCH', url: '/c-1', body: { makeDefault: 'true' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'makeDefault is true or false.');
    assert.deepStrictEqual(touched, []);
});

test('PATCH makeDefault: true still sets the default', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/c-1', body: { makeDefault: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'setDefault'));
});

test('PATCH makeDefault: false still leaves the default alone', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/c-1', body: { makeDefault: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!touched.some((t) => t.what === 'setDefault'));
});

// ── The rename that reverted ────────────────────────────────────────

test('a label of the wrong JSON type is refused, not skipped under a 200', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/c-1', body: { label: 42 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A connection label must be text.');
    assert.deepStrictEqual(touched, [], 'nothing was renamed');
});

test('a misspelled PATCH key is refused rather than dropped', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/c-1', body: { lable: 'Renamed' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /lable/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, []);
});

test('a real rename still reaches the store', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/c-1', body: { label: 'Renamed' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'renameConnection').args, ['c-1', 'Renamed']);
});

test('a PATCH with no body at all is still a no-op 200', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/c-1', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, []);
});

// ── resourceType: checked on the write, not on the reads ────────────

test('a misspelled resourceType on the grants read is refused, not narrowed to nothing', async () => {
    const res = await dispatch({ method: 'GET', url: '/grants', query: { resourceType: 'agnet', resourceId: 'a1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Invalid resourceType');
    assert.deepStrictEqual(touched, [], 'the store was never asked');
});

test('a misspelled resourceType on the pre-flight is refused too', async () => {
    const res = await dispatch({
        method: 'GET', url: '/required',
        query: { providers: 'slack', resourceType: 'studio-app', resourceId: 'a1' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Invalid resourceType');
    assert.deepStrictEqual(touched, []);
});

test("the policy picker's own grants read still works", async () => {
    const res = await dispatch({ method: 'GET', url: '/grants', query: { resourceType: 'agent', resourceId: 'a1' } });
    assert.strictEqual(res.statusCode, 200);
    const filter = touched.find((t) => t.what === 'listGrants').args[0];
    assert.strictEqual(filter.grantorUserId, 'u1');
    assert.strictEqual(filter.resourceType, 'agent');
});

test("the app runner's own pre-flight still works", async () => {
    const res = await dispatch({
        method: 'GET', url: '/required',
        query: { providers: 'slack,github', resourceType: 'studio_app', resourceId: 'a1' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.filter((t) => t.what === 'resolveForRun').length, 2);
});

// ── The share body ──────────────────────────────────────────────────

test('a misspelled share key is refused rather than lending on different terms', async () => {
    const res = await dispatch({
        method: 'POST', url: '/c-1/grants',
        body: { granteeType: 'user', granteeId: 'u2', expiresat: '2099-01-01T00:00:00.000Z' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /expiresat/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'nothing was lent');
});

test('an unknown granteeType is still refused, before the store', async () => {
    const res = await dispatch({ method: 'POST', url: '/c-1/grants', body: { granteeType: 'team' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Invalid granteeType');
    assert.deepStrictEqual(touched, []);
});

test('an org-wide share with no expiry still goes through, with expiresAt null', async () => {
    const res = await dispatch({ method: 'POST', url: '/c-1/grants', body: { granteeType: 'org', expiresAt: null } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'shareConnection').args[0].expiresAt, null);
});

test("an empty expiresAt — the share panel's own 'no expiry' — is still no expiry", async () => {
    const res = await dispatch({ method: 'POST', url: '/c-1/grants', body: { granteeType: 'org', expiresAt: '' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'shareConnection').args[0].expiresAt, null);
});

// ── The create body ─────────────────────────────────────────────────

test('a misspelled create key is refused rather than stored without it', async () => {
    const res = await dispatch({
        method: 'POST', url: '/',
        body: { provider: 'slack', kind: 'api_key', secret: { api_key: 'x' }, secretMata: { headerName: 'X-Key' } },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /secretMata/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, []);
});

test('a secret that is not an object of fields is still refused', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { provider: 'slack', secret: ['api_key', 'x'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'secret must be an object of fields.');
    assert.deepStrictEqual(touched, []);
});

test('an unknown kind is still refused, in the same words as before', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { provider: 'slack', kind: 'apikey' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Invalid kind');
    assert.deepStrictEqual(touched, []);
});

test('the connections panel body still creates a connection', async () => {
    const res = await dispatch({
        method: 'POST', url: '/',
        body: { provider: 'slack', kind: 'api_key', label: 'Work', secret: { api_key: 'xoxb-1' } },
    });
    assert.strictEqual(res.statusCode, 201);
    const args = touched.find((t) => t.what === 'createConnection').args[0];
    assert.strictEqual(args.label, 'Work');
    assert.strictEqual(args.makeDefault, false);
});
