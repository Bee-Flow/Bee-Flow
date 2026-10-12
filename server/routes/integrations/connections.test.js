/**
 * API tests for routes/integrations/connections.js — focuses on wiring + the
 * security-critical org-isolation on the share endpoint. The store / userStore
 * / permissions modules are mocked; a real express app is exercised over http.
 *
 * Run: node routes/integrations/connections.test.js
 */

const assert = require('assert');
const Module = require('module');
const express = require('express');

process.env.NODE_ENV = 'test';

// ── Mocks injected before the route loads ───────────────────────────
function mock(id, exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const SENTINEL = '__default_org__';
const resolveOrgId = (o) => (o && String(o).trim()) || SENTINEL;

const state = {
    connections: {},   // id -> shaped connection
    users: {},         // id -> { organizationId }
    groups: [],        // [{ id, organizationId }]
    grants: [],
    lastShare: null,
    resolveResult: { mode: 'byo_required', available: false },
    legacyIntegration: false,
    // Feature C capture points
    lastCreate: null,
    lastSecretUpdate: null,
    lastMetaUpdate: null,
    accessible: [],
    lastAccessibleArgs: null,
    audits: [],
    lastGrantFilter: null,
    revokes: [],
};

mock('../../auth/permissions', {
    requireActiveOrgForMutations: () => (req, res, next) => next(),
    // The routes gate each endpoint with requireAuth; mimic its contract
    // (session-or-401) without the DB user check.
    requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Unauthorized' })),
});
mock('../../stores/userStore', {
    getUser: async (id) => state.users[id] || null,
    getUserByEmail: async (email) => {
        const hit = Object.entries(state.users).find(([, u]) => u.email === email);
        return hit ? { id: hit[0], ...hit[1] } : null;
    },
    getAllGroups: async () => state.groups,
    logAccessAudit: async (...args) => { state.audits.push(args); },
});
mock('../../auth/oauthRoutes', {
    revokeProviderCredential: async (userId, provider) => {
        state.revokes.push({ userId, provider });
        return { found: true, deleted: true };
    },
});
// /required falls back to the LEGACY integration layer before demanding a
// connection (most Google/Microsoft credentials live there, not in the new
// registry) — mocked so these tests stay hermetic.
mock('../../appStudio/mailboxIdentity', {
    viewerHasIntegration: async () => state.legacyIntegration,
});
mock('../../stores/integrationConnectionStore', {
    resolveOrgId,
    listConnectionsForUser: async (uid) => Object.values(state.connections).filter(c => c.ownerUserId === uid),
    getConnection: async (id) => state.connections[id] || null,
    createConnection: async (args) => {
        state.lastCreate = args;
        const id = `c-${Object.keys(state.connections).length + 1}`;
        const conn = { id, ownerUserId: args.ownerUserId, orgId: resolveOrgId(args.orgId), provider: args.provider, label: args.label, kind: args.kind, secretMeta: args.secretMeta || {}, isDefault: true };
        state.connections[id] = conn;
        return conn;
    },
    shareConnection: async (args) => { state.lastShare = args; const g = { id: `g-${state.grants.length + 1}`, ...args }; state.grants.push(g); return g; },
    // Faithful to the real store: applies EVERY filter, and refuses an
    // unscoped call. Without the refusal this mock would happily return the
    // whole table and hide exactly the bug these tests exist to catch.
    listGrants: async (f = {}) => {
        state.lastGrantFilter = f;
        const scoping = ['connectionId', 'granteeId', 'grantorUserId', 'orgId'].filter(k => f[k]);
        if (scoping.length === 0) throw new Error('listGrants requires at least one scoping filter');
        // Rows come back as `cg.*` (snake_case) from the real store, but
        // shareConnection() captures its camelCase args — accept either.
        const f_ = (g, snake, camel) => g[snake] ?? g[camel];
        return state.grants.filter(g =>
            (!f.connectionId || f_(g, 'connection_id', 'connectionId') === f.connectionId)
            && (!f.grantorUserId || f_(g, 'grantor_user_id', 'grantorUserId') === f.grantorUserId)
            && (!f.granteeId || f_(g, 'grantee_id', 'granteeId') === f.granteeId)
            && (!f.orgId || resolveOrgId(f_(g, 'org_id', 'orgId')) === resolveOrgId(f.orgId))
        );
    },
    getGrant: async (id) => state.grants.find(g => g.id === id) || null,
    revokeGrant: async () => true,
    deleteConnection: async (id) => { delete state.connections[id]; return true; },
    renameConnection: async () => true,
    setDefault: async () => true,
    updateConnectionSecret: async (id, secretObject, secretMeta = null) => { state.lastSecretUpdate = { id, secretObject, secretMeta }; return true; },
    updateConnectionMeta: async (id, secretMeta) => { state.lastMetaUpdate = { id, secretMeta }; if (state.connections[id]) state.connections[id].secretMeta = secretMeta; return true; },
    listAccessibleConnections: async (args) => { state.lastAccessibleArgs = args; return state.accessible; },
    resolveConnectionForRun: async ({ provider }) => ({ ...state.resolveResult, provider, connectionLabel: state.resolveResult.connectionLabel }),
    _internals: { OAUTH_AUTOMATION_PROVIDERS: new Set(['google', 'microsoft', 'nextcloud']) },
});

const router = require('./connections');

// ── Test app: inject a session from the x-user header ───────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const uid = req.headers['x-user'];
    const role = req.headers['x-role'];
    req.session = uid ? { user: { id: uid, role: role || 'user' } } : {};
    next();
});
app.use('/api/integrations/connections', router);
// A schema refusal travels as an error to the terminal handler, so the test
// app has to mount one the way index.js does — otherwise a 400 comes back as
// express's default HTML page and every assertion on `json.error` reads null.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
app.use(terminalErrorHandler);

let server, base;
async function http(method, path, { user, role, body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-user'] = user;
    if (role) headers['x-role'] = role;
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

async function run() {
    console.log('connections API');
    await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });

    // Seed: owner u1 in orgA; teammate u2 in orgA; outsider u3 in orgB
    state.users = {
        u1: { organizationId: 'orgA', email: 'owner@acme.test' },
        u2: { organizationId: 'orgA', email: 'teammate@acme.test' },
        u3: { organizationId: 'orgB', email: 'outsider@other.test' },
    };

    await test('401 without a session', async () => {
        const r = await http('GET', '/api/integrations/connections');
        assert.strictEqual(r.status, 401);
    });

    await test('POST / creates a connection scoped to the caller org', async () => {
        const r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'slack', label: 'Work', kind: 'api_key', secret: { api_key: 'xoxb-1' } } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.json.connection.ownerUserId, 'u1');
        assert.strictEqual(r.json.connection.orgId, 'orgA');
    });

    await test('POST / rejects an invalid provider', async () => {
        const r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'bad provider!!' } });
        assert.strictEqual(r.status, 400);
    });

    await test('share to a SAME-org user → 201', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', { user: 'u1', body: { granteeType: 'user', granteeId: 'u2' } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(state.lastShare.granteeId, 'u2');
    });

    await test('share to a CROSS-org user → 403 (hard isolation)', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', { user: 'u1', body: { granteeType: 'user', granteeId: 'u3' } });
        assert.strictEqual(r.status, 403);
        assert.match(r.json.error, /Cross-org/);
    });

    await test('share a connection you do NOT own → 403 Forbidden', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', { user: 'u2', body: { granteeType: 'user', granteeId: 'u1' } });
        assert.strictEqual(r.status, 403);
        assert.match(r.json.error, /Forbidden/);
    });

    await test('share with resourceType but no resourceId → 400', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', { user: 'u1', body: { granteeType: 'user', granteeId: 'u2', resourceType: 'agent' } });
        assert.strictEqual(r.status, 400);
    });

    await test('GET /required reports byo-missing vs lent per provider', async () => {
        state.resolveResult = { mode: 'byo_required', available: false };
        let r = await http('GET', '/api/integrations/connections/required?providers=slack,github', { user: 'u2' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.requiresConnection.length, 2);
        state.resolveResult = { mode: 'delegated', available: true, connectionLabel: 'Owner Slack' };
        r = await http('GET', '/api/integrations/connections/required?providers=slack', { user: 'u2' });
        assert.strictEqual(r.json.lent.length, 1);
        assert.strictEqual(r.json.lent[0].connectionLabel, 'Owner Slack');
    });

    await test('GET /required is satisfied by the LEGACY integration layer', async () => {
        // No row in the new connections registry, but the user's SSO/vault
        // credential (the layer the runtime consults first) has the provider —
        // the pre-flight must not tell them to "connect" what already works.
        state.resolveResult = { mode: 'byo_required', available: false };
        state.legacyIntegration = true;
        const r = await http('GET', '/api/integrations/connections/required?providers=gmail', { user: 'u2' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.requiresConnection.length, 0);
        state.legacyIntegration = false;
    });

    await test('DELETE /:id blocked while shared, allowed with ?force=1', async () => {
        state.grants = [{ id: 'g-x', connectionId: 'c-1' }];
        let r = await http('DELETE', '/api/integrations/connections/c-1', { user: 'u1' });
        assert.strictEqual(r.status, 409);
        r = await http('DELETE', '/api/integrations/connections/c-1?force=1', { user: 'u1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.deleted, true);
    });

    // ── Feature C: provider 'http' credentials ──────────────────────

    await test('POST http/bearer accepts the new kind; extras stripped from the secret blob', async () => {
        const r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', label: 'My API', kind: 'bearer', secret: { token: 'tok-bearer-1', sneaky: 'extra' } } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.json.connection.kind, 'bearer');
        assert.deepStrictEqual(state.lastCreate.secretObject, { token: 'tok-bearer-1' }, 'blob holds exactly the per-kind fields');
        assert.ok(!('secret' in r.json.connection), 'response never carries the secret');
        assert.ok(!JSON.stringify(r.json).includes('tok-bearer-1'), 'secret value never appears in the response');
    });

    await test('POST http/oauth2_cc accepts the new kind with tokenUrl + derived clientIdHint', async () => {
        const r = await http('POST', '/api/integrations/connections', {
            user: 'u1',
            body: {
                provider: 'http', label: 'OAuth API', kind: 'oauth2_cc',
                secret: { client_id: 'my-client-1', client_secret: 'cs-secret-1' },
                secretMeta: { tokenUrl: 'https://auth.example.com/token', scope: 'read write', clientIdHint: 'client-sent-must-be-ignored' },
            },
        });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(state.lastCreate.secretMeta.tokenUrl, 'https://auth.example.com/token');
        assert.strictEqual(state.lastCreate.secretMeta.scope, 'read write');
        assert.strictEqual(state.lastCreate.secretMeta.tokenAuthMethod, 'client_secret_post', 'default tokenAuthMethod');
        assert.strictEqual(state.lastCreate.secretMeta.clientIdHint, 'my-c…', 'hint derived server-side, client value discarded');
        assert.ok(!JSON.stringify(r.json).includes('cs-secret-1'), 'client_secret never in the response');
    });

    await test('POST http missing per-kind secret fields → 400', async () => {
        let r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'bearer', secret: {} } });
        assert.strictEqual(r.status, 400);
        assert.match(r.json.error, /secret\.token/);
        r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'basic', secret: { username: 'u' } } });
        assert.strictEqual(r.status, 400);
        assert.match(r.json.error, /secret\.password/);
        r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'oauth2_cc', secret: { client_id: 'x' }, secretMeta: { tokenUrl: 'https://a.example/t' } } });
        assert.strictEqual(r.status, 400);
        assert.match(r.json.error, /secret\.client_secret/);
    });

    await test('POST http/api_key validates headerName (required, charset, denylist)', async () => {
        let r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'api_key', secret: { token: 't1' } } });
        assert.strictEqual(r.status, 400, 'headerName required');
        r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'api_key', secret: { token: 't1' }, secretMeta: { headerName: 'X API Key' } } });
        assert.strictEqual(r.status, 400, 'spaces rejected');
        r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'api_key', secret: { token: 't1' }, secretMeta: { headerName: 'Host' } } });
        assert.strictEqual(r.status, 400, 'forbidden header rejected');
        r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'api_key', secret: { token: 't1' }, secretMeta: { headerName: 'X-API-Key' } } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(state.lastCreate.secretMeta.headerName, 'X-API-Key');
    });

    await test('POST http rejects meta keys outside the per-kind allowlist', async () => {
        const r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'bearer', secret: { token: 't1' }, secretMeta: { headerName: 'X-Key' } } });
        assert.strictEqual(r.status, 400);
        assert.match(r.json.error, /not allowed/);
    });

    await test('POST http/oauth2_cc validates tokenUrl + tokenAuthMethod', async () => {
        let r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'oauth2_cc', secret: { client_id: 'a', client_secret: 'b' }, secretMeta: { tokenUrl: 'not-a-url' } } });
        assert.strictEqual(r.status, 400);
        assert.match(r.json.error, /tokenUrl/);
        r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'oauth2_cc', secret: { client_id: 'a', client_secret: 'b' }, secretMeta: { tokenUrl: 'ftp://a.example/t' } } });
        assert.strictEqual(r.status, 400, 'non-http(s) scheme rejected');
        r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'http', kind: 'oauth2_cc', secret: { client_id: 'a', client_secret: 'b' }, secretMeta: { tokenUrl: 'https://a.example/t', tokenAuthMethod: 'private_key_jwt' } } });
        assert.strictEqual(r.status, 400, 'unsupported tokenAuthMethod rejected');
    });

    await test('GET /?provider=http&includeShared=1 returns own+lent with access flags', async () => {
        state.accessible = [
            { id: 'c-own', ownerUserId: 'u1', provider: 'http', label: 'Mine', kind: 'bearer', access: 'own' },
            { id: 'c-lent', ownerUserId: 'u2', provider: 'http', label: 'Shared', kind: 'basic', access: 'lent' },
        ];
        const r = await http('GET', '/api/integrations/connections?provider=http&includeShared=1', { user: 'u1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.connections.length, 2);
        assert.deepStrictEqual(r.json.connections.map(c => c.access), ['own', 'lent']);
        assert.strictEqual(state.lastAccessibleArgs.provider, 'http');
        assert.strictEqual(state.lastAccessibleArgs.userId, 'u1');
    });

    await test('GET / without includeShared keeps the own-only listing (unchanged default)', async () => {
        state.lastAccessibleArgs = null;
        const r = await http('GET', '/api/integrations/connections?provider=http', { user: 'u1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(state.lastAccessibleArgs, null, 'listAccessibleConnections not used on the default path');
        assert.ok(r.json.connections.every(c => c.ownerUserId === 'u1'));
    });

    await test('PATCH http secret rotation is write-only and re-derives display meta', async () => {
        const bearerId = Object.values(state.connections).find(c => c.provider === 'http' && c.kind === 'bearer').id;
        const r = await http('PATCH', `/api/integrations/connections/${bearerId}`, { user: 'u1', body: { secret: { token: 'tok-rotated-9' } } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(state.lastSecretUpdate.secretObject, { token: 'tok-rotated-9' });
        assert.ok(!JSON.stringify(r.json).includes('tok-rotated-9'), 'rotated secret never echoed');
    });

    await test('PATCH http rotation with an incomplete blob → 400 (full-blob replacement)', async () => {
        const oauthConn = Object.values(state.connections).find(c => c.provider === 'http' && c.kind === 'oauth2_cc');
        const r = await http('PATCH', `/api/integrations/connections/${oauthConn.id}`, { user: 'u1', body: { secret: { client_id: 'only-half' } } });
        assert.strictEqual(r.status, 400);
        assert.match(r.json.error, /client_secret/);
    });

    await test('PATCH http meta-only update goes through updateConnectionMeta and preserves clientIdHint', async () => {
        const oauthConn = Object.values(state.connections).find(c => c.provider === 'http' && c.kind === 'oauth2_cc');
        oauthConn.secretMeta = { tokenUrl: 'https://auth.example.com/token', tokenAuthMethod: 'client_secret_post', clientIdHint: 'my-c…' };
        const r = await http('PATCH', `/api/integrations/connections/${oauthConn.id}`, { user: 'u1', body: { secretMeta: { tokenUrl: 'https://auth2.example.com/token', tokenAuthMethod: 'client_secret_basic' } } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(state.lastMetaUpdate.secretMeta.tokenUrl, 'https://auth2.example.com/token');
        assert.strictEqual(state.lastMetaUpdate.secretMeta.tokenAuthMethod, 'client_secret_basic');
        assert.strictEqual(state.lastMetaUpdate.secretMeta.clientIdHint, 'my-c…', 'derived hint carried over');
    });

    await test('PATCH by a non-owner → 403', async () => {
        const anyHttp = Object.values(state.connections).find(c => c.provider === 'http');
        const r = await http('PATCH', `/api/integrations/connections/${anyHttp.id}`, { user: 'u3', body: { secret: { token: 'stolen' } } });
        assert.strictEqual(r.status, 403);
    });

    await test('PATCH by a CROSS-ORG admin → 403 (tokenUrl redirect = secret disclosure vector)', async () => {
        const oauthConn = Object.values(state.connections).find(c => c.provider === 'http' && c.kind === 'oauth2_cc');
        const r = await http('PATCH', `/api/integrations/connections/${oauthConn.id}`, {
            user: 'u3', role: 'admin',
            body: { secretMeta: { tokenUrl: 'https://evil.example.com/token' } },
        });
        assert.strictEqual(r.status, 403, 'admin role must not reach another tenant\'s credentials');
        assert.notStrictEqual(state.lastMetaUpdate?.secretMeta?.tokenUrl, 'https://evil.example.com/token');
    });

    await test('PATCH by a SAME-ORG admin → allowed', async () => {
        const anyHttp = Object.values(state.connections).find(c => c.provider === 'http' && c.kind === 'bearer');
        const r = await http('PATCH', `/api/integrations/connections/${anyHttp.id}`, { user: 'u2', role: 'admin', body: { label: 'Renamed by org admin' } });
        assert.strictEqual(r.status, 200);
    });

    await test('audit entries were emitted for create/rotate/update_meta and NEVER contain secret values', async () => {
        assert.ok(state.audits.some(a => a[0] === 'credential.create'), 'create audited');
        assert.ok(state.audits.some(a => a[0] === 'credential.rotate'), 'rotate audited');
        assert.ok(state.audits.some(a => a[0] === 'credential.update_meta'), 'meta-only update audited (tokenUrl changes must be traceable)');
        const flat = JSON.stringify(state.audits);
        for (const v of ['tok-bearer-1', 'cs-secret-1', 'tok-rotated-9', 'my-client-1']) {
            assert.ok(!flat.includes(v), `audit log must not contain secret value ${v}`);
        }
    });

    // ── Grant listing: tenant scoping ───────────────────────────────
    // Regression guard for a cross-tenant leak: GET /grants derived its caller
    // filter from `!mine && !connectionId`, so ANY other value of `mine` — or
    // any connectionId — reached listGrants with an empty filter and returned
    // every active grant in the deployment (connection ids, labels, providers,
    // owner and grantee ids) across all orgs.
    await test('GET /grants defaults to the caller\'s own outgoing lends', async () => {
        // Real row shape: the store returns `cg.*` plus the joined connection columns.
        state.grants = [
            { id: 'g-a', connection_id: 'c-1', grantor_user_id: 'u1', grantee_type: 'user', grantee_id: 'u2', org_id: 'orgA' },
            { id: 'g-b', connection_id: 'c-99', grantor_user_id: 'u3', grantee_type: 'user', grantee_id: 'u9', org_id: 'orgB' },
        ];
        const r = await http('GET', '/api/integrations/connections/grants', { user: 'u1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(state.lastGrantFilter.grantorUserId, 'u1', 'caller scope must always be applied');
        assert.deepStrictEqual(r.json.grants.map(g => g.id), ['g-a']);
    });

    await test('GET /grants?mine=<junk> → 400, never an unscoped dump', async () => {
        for (const junk of ['x', 'all', '1', 'OUTGOING ']) {
            const r = await http('GET', `/api/integrations/connections/grants?mine=${encodeURIComponent(junk)}`, { user: 'u1' });
            assert.strictEqual(r.status, 400, `mine=${junk} must be rejected`);
            assert.ok(!r.json.grants, 'no grants may be returned for an invalid scope');
        }
    });

    await test('GET /grants?connectionId= cannot escape the caller scope', async () => {
        // u3's grant, requested by u1 — the connectionId must narrow WITHIN
        // u1's own grants, not replace the ownership filter.
        const r = await http('GET', '/api/integrations/connections/grants?connectionId=c-99', { user: 'u1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(state.lastGrantFilter.grantorUserId, 'u1');
        assert.deepStrictEqual(r.json.grants, [], 'must not expose another user\'s grant');
    });

    await test('GET /grants?mine=incoming is scoped to the caller AND their org', async () => {
        const r = await http('GET', '/api/integrations/connections/grants?mine=incoming', { user: 'u2' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(state.lastGrantFilter.granteeId, 'u2');
        assert.strictEqual(state.lastGrantFilter.orgId, 'orgA', 'incoming lends must be org-filtered too');
    });

    await test('GET /grants decorates grantees with a label instead of a bare id', async () => {
        const r = await http('GET', '/api/integrations/connections/grants', { user: 'u1' });
        assert.strictEqual(r.json.grants[0].grantee_label, 'teammate@acme.test');
    });

    // ── Grant revoke ────────────────────────────────────────────────
    await test('DELETE /grants/:id — grantor may revoke', async () => {
        const r = await http('DELETE', '/api/integrations/connections/grants/g-a', { user: 'u1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.revoked, true);
    });

    await test('DELETE /grants/:id — unrelated user → 403', async () => {
        const r = await http('DELETE', '/api/integrations/connections/grants/g-a', { user: 'u2' });
        assert.strictEqual(r.status, 403);
    });

    await test('DELETE /grants/:id — CROSS-ORG admin → 403 (admin stops at the tenant edge)', async () => {
        const r = await http('DELETE', '/api/integrations/connections/grants/g-a', { user: 'u3', role: 'admin' });
        assert.strictEqual(r.status, 403, 'an admin of orgB must not revoke an orgA grant');
    });

    await test('DELETE /grants/:id — SAME-ORG admin → allowed', async () => {
        const r = await http('DELETE', '/api/integrations/connections/grants/g-a', { user: 'u2', role: 'admin' });
        assert.strictEqual(r.status, 200);
    });

    await test('DELETE /grants/:id — unknown id → 404', async () => {
        const r = await http('DELETE', '/api/integrations/connections/grants/does-not-exist', { user: 'u1' });
        assert.strictEqual(r.status, 404);
    });

    // ── Share-by-email must not answer "does this account exist?" ────
    await test('share by email: unknown address and other-tenant address are INDISTINGUISHABLE', async () => {
        const unknown = await http('POST', '/api/integrations/connections/c-1/grants', {
            user: 'u1', body: { granteeType: 'user', granteeEmail: 'nobody@nowhere.test' },
        });
        const otherTenant = await http('POST', '/api/integrations/connections/c-1/grants', {
            user: 'u1', body: { granteeType: 'user', granteeEmail: 'outsider@other.test' },
        });
        assert.strictEqual(unknown.status, 404);
        assert.strictEqual(otherTenant.status, 404, 'a cross-org hit must not be distinguishable from a miss');
        assert.strictEqual(unknown.json.error, otherTenant.json.error, 'error text must match exactly');
    });

    await test('share by email: same-org teammate still resolves', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', {
            user: 'u1', body: { granteeType: 'user', granteeEmail: 'teammate@acme.test' },
        });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(state.lastShare.granteeId, 'u2');
    });

    await test('share with an explicit cross-org granteeId keeps the informative 403', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', {
            user: 'u1', body: { granteeType: 'user', granteeId: 'u3' },
        });
        assert.strictEqual(r.status, 403, 'no disclosure here — the caller already holds the id');
    });

    // ── expiresAt validation (used to reach .toISOString() and throw a 500) ──
    await test('share with a malformed or past expiresAt → 400, not 500', async () => {
        const bad = await http('POST', '/api/integrations/connections/c-1/grants', {
            user: 'u1', body: { granteeType: 'org', expiresAt: 'not-a-date' },
        });
        assert.strictEqual(bad.status, 400);
        const past = await http('POST', '/api/integrations/connections/c-1/grants', {
            user: 'u1', body: { granteeType: 'org', expiresAt: '2000-01-01T00:00:00.000Z' },
        });
        assert.strictEqual(past.status, 400);
        const ok = await http('POST', '/api/integrations/connections/c-1/grants', {
            user: 'u1', body: { granteeType: 'org', expiresAt: new Date(Date.now() + 86400000).toISOString() },
        });
        assert.strictEqual(ok.status, 201);
        assert.ok(state.lastShare.expiresAt, 'a valid future expiry is passed through');
    });

    // ── Deleting an OAuth row must actually disconnect ───────────────
    await test('DELETE of an owned OAuth connection revokes the live credential', async () => {
        state.connections['c-oauth'] = { id: 'c-oauth', ownerUserId: 'u1', orgId: 'orgA', provider: 'google', kind: 'oauth', label: 'tom@acme.test', secretMeta: {} };
        state.grants = [];
        state.revokes = [];
        const r = await http('DELETE', '/api/integrations/connections/c-oauth', { user: 'u1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.credentialRevoked, true);
        assert.deepStrictEqual(state.revokes, [{ userId: 'u1', provider: 'google' }],
            'dropping the metadata row alone would leave the user still connected');
    });

    await test('an ADMIN deleting someone else\'s OAuth row does NOT revoke their tokens', async () => {
        state.connections['c-oauth2'] = { id: 'c-oauth2', ownerUserId: 'u1', orgId: 'orgA', provider: 'google', kind: 'oauth', label: 'tom@acme.test', secretMeta: {} };
        state.revokes = [];
        const r = await http('DELETE', '/api/integrations/connections/c-oauth2', { user: 'u2', role: 'admin' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(state.revokes, [], 'revoking another user\'s third-party access is not "tidy up a row"');
    });

    await test('DELETE of a non-OAuth connection does not touch the OAuth vault', async () => {
        state.connections['c-key'] = { id: 'c-key', ownerUserId: 'u1', orgId: 'orgA', provider: 'fireflies', kind: 'api_key', label: 'Work', secretMeta: {} };
        state.revokes = [];
        const r = await http('DELETE', '/api/integrations/connections/c-key', { user: 'u1' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(state.revokes, []);
    });

    // ── Server errors must not echo internals ───────────────────────
    await test('a 500 returns a generic message, never the raw driver error', async () => {
        const store = require('../../stores/integrationConnectionStore');
        const original = store.listConnectionsForUser;
        store.listConnectionsForUser = async () => { throw new Error('relation "integration_connections" does not exist at character 42'); };
        const r = await http('GET', '/api/integrations/connections', { user: 'u1' });
        store.listConnectionsForUser = original;
        assert.strictEqual(r.status, 500);
        assert.ok(!/relation|character 42/.test(r.json.error), `leaked internals: ${r.json.error}`);
    });

    console.log(`\nconnections API: ${passed} passed\n`);
    server.close();
}

run().catch(err => { console.error(err); if (server) server.close(); process.exit(1); });
