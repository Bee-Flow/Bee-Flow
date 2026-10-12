'use strict';

/**
 * /api/mcp-tokens: the caller's own named MCP tokens.
 * Run: node --test routes/mcpTokens.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../core/http/routeHarness');
h.recordDb(); // userStore starts its schema on load; keep it off a real database
const tokenStore = require('../auth/mcpAccess/tokenStore');
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');

// ── Stand-ins for the SQL layer, the secret store and the audit log ────────
const rows = new Map();
const audits = [];
const secrets = new Map();

tokenStore._test.setRepo({
    async insert(r) {
        const row = { ...r, createdAt: '2026-10-10T12:00:00.000Z', lastUsedAt: null, revokedAt: null, disabledAt: null };
        rows.set(r.id, row);
        const { secretHash, ...record } = row;
        return { ...record, enabled: true };
    },
    async listByUser(userId) {
        return [...rows.values()].filter((r) => r.userId === userId).map(({ secretHash, ...rec }) => ({ ...rec, enabled: !rec.disabledAt }));
    },
    async countActiveByUser(userId) { return [...rows.values()].filter((r) => r.userId === userId && !r.revokedAt).length; },
    async getWithHash() { return null; },
    async revoke(userId, id) {
        const row = rows.get(id);
        if (!row || row.userId !== userId) return null;
        row.revokedAt = row.revokedAt || '2026-10-10T13:00:00.000Z';
        const { secretHash, ...record } = row;
        return record;
    },
    async setEnabled(userId, id, enabled) {
        const row = rows.get(id);
        if (!row || row.userId !== userId) return null;
        if (!row.revokedAt) row.disabledAt = enabled ? null : (row.disabledAt || '2026-10-10T14:00:00.000Z');
        const { secretHash, ...record } = row;
        return { ...record, enabled: !row.disabledAt };
    },
    async touch() {},
});
// The accounts the route reads fresh (groups are not on the session copy).
const accounts = new Map();
let groupsError = null;
const realGetSecret = configStore.getSecret;
const realAudit = userStore.logAccessAudit;
const realGetUser = userStore.getUser;
const realGetAllGroups = userStore.getAllGroups;
configStore.getSecret = async (k) => secrets.get(k) ?? null;
userStore.logAccessAudit = async (...args) => { audits.push(args); };
userStore.getUser = async (id) => accounts.get(id) ?? null;
userStore.getAllGroups = async () => {
    if (groupsError) throw groupsError;
    return [{ id: 'g1', organizationId: 'org7' }, { id: 'g2', organizationId: 'org8' }];
};

const mcpTokensRouter = require('./mcpTokens');
const api = h.serve('/api/mcp-tokens', mcpTokensRouter);

/** Everything on offer, unless a test says otherwise. */
const ALL_ELIGIBLE = () => ({
    policy: { allowed: true },
    integrations: { available: true },
    automations: { available: true },
    studio: { available: true, canWrite: true },
    cms: { available: true, canPublish: true },
});
test.after(async () => {
    await api.close();
    configStore.getSecret = realGetSecret;
    userStore.logAccessAudit = realAudit;
    userStore.getUser = realGetUser;
    userStore.getAllGroups = realGetAllGroups;
    tokenStore._test.setRepo(null);
    mcpTokensRouter._test.setEligibility(null);
});
test.beforeEach(() => {
    rows.clear(); audits.length = 0; secrets.clear(); groupsError = null; accounts.clear();
    mcpTokensRouter._test.setEligibility(async () => ALL_ELIGIBLE());
    accounts.set('alice', { id: 'alice', organizationId: 'org1', groups: [] });
    accounts.set('bob', { id: 'bob', organizationId: 'org1', groups: [] });
});

const ALICE = { id: 'alice', organizationId: 'org1', role: 'user' };
const BOB = { id: 'bob', organizationId: 'org1', role: 'user' };
const create = (body, user = ALICE) => api.call('POST', '/api/mcp-tokens', { body, user });

test('no session is a 401', async () => {
    assert.equal((await api.call('GET', '/api/mcp-tokens', { user: null })).status, 401);
    assert.equal((await api.call('POST', '/api/mcp-tokens', { user: null, body: { name: 'x', scopes: { studio: { level: 'read' } } } })).status, 401);
    assert.equal((await api.call('DELETE', '/api/mcp-tokens/abc', { user: null })).status, 401);
});

test('POST returns 201 with the plaintext token once, and the record without any secret', async () => {
    const res = await create({ name: 'Cursor', scopes: { automations: { level: 'write' } }, ipAllowlist: ['203.0.113.0/24'], expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString() });
    assert.equal(res.status, 201, res.text);
    assert.match(res.body.token, /^bfmcp_[a-f0-9]{32}_[a-f0-9]{64}$/);
    assert.equal(res.body.record.name, 'Cursor');
    assert.deepEqual(res.body.record.scopes, { automations: { level: 'write' } });
    assert.deepEqual(res.body.record.ipAllowlist, ['203.0.113.0/24']);
    assert.equal(res.body.record.userId, 'alice');
    assert.equal(res.body.record.orgId, 'org1');
    const secret = res.body.token.split('_')[2];
    assert.equal(JSON.stringify(res.body.record).includes(secret), false);

    const list = await api.call('GET', '/api/mcp-tokens', { user: ALICE });
    assert.equal(JSON.stringify(list.body).includes(secret), false, 'the secret is never listed');
});

test('POST audits mcp.token.create', async () => {
    const res = await create({ name: 'Cursor', scopes: { studio: { level: 'read' } } });
    assert.equal(audits.length, 1);
    const [action, targetType, targetId, actor, before, after, orgId] = audits[0];
    assert.deepEqual([action, targetType, targetId, actor, before, orgId], ['mcp.token.create', 'mcp_token', res.body.record.id, 'alice', null, 'org1']);
    assert.equal(after.name, 'Cursor');
    assert.equal(JSON.stringify(audits).includes(res.body.token), false, 'the audit row never holds the token');
});

test('POST refuses bad input with a 400 in a sentence', async () => {
    const bad = [
        undefined, {}, { name: 'x' }, { scopes: { studio: { level: 'read' } } },
        { name: '', scopes: { studio: { level: 'read' } } },
        { name: 'x', scopes: {} },
        { name: 'x', scopes: { nope: { level: 'read' } } },
        { name: 'x', scopes: { studio: { level: 'sudo' } } },
        { name: 'x', scopes: { studio: { level: 'read' } }, ipAllowlist: ['nope'] },
        { name: 'x', scopes: { studio: { level: 'read' } }, expiresAt: '2001-01-01T00:00:00Z' },
        { name: 'x', scopes: { studio: { level: 'read' } }, userId: 'bob' },
    ];
    for (const body of bad) {
        const res = await create(body);
        assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
        assert.ok(res.body.error && res.body.error.length > 5);
        assert.doesNotMatch(res.body.error, /^(Required$|Expected |Invalid input|Unrecognized key)/, res.body.error);
    }
    assert.equal(rows.size, 0);
});

test('GET lists only the caller\'s tokens with the contract fields, and reports the legacy token', async () => {
    await create({ name: 'mine', scopes: { studio: { level: 'read' } } });
    await create({ name: 'bobs', scopes: { studio: { level: 'read' } } }, BOB);
    const res = await api.call('GET', '/api/mcp-tokens', { user: ALICE });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.tokens.map((t) => t.name), ['mine']);
    assert.deepEqual(Object.keys(res.body.tokens[0]).sort(),
        ['createdAt', 'disabledAt', 'enabled', 'expiresAt', 'id', 'ipAllowlist', 'lastUsedAt', 'name', 'revokedAt', 'scopes']);
    assert.deepEqual(res.body.legacy, { exists: false });

    secrets.set('mcp_server_token_user_alice', 'abc');
    assert.deepEqual((await api.call('GET', '/api/mcp-tokens', { user: ALICE })).body.legacy, { exists: true });
    secrets.set('mcp_server_token_user_alice_revoked', '1');
    assert.deepEqual((await api.call('GET', '/api/mcp-tokens', { user: ALICE })).body.legacy, { exists: false });
});

test('DELETE revokes your own token (204) and audits it', async () => {
    const { body } = await create({ name: 'mine', scopes: { studio: { level: 'read' } } });
    audits.length = 0;
    const res = await api.call('DELETE', `/api/mcp-tokens/${body.record.id}`, { user: ALICE });
    assert.equal(res.status, 204);
    assert.ok(rows.get(body.record.id).revokedAt);
    assert.equal(audits.length, 1);
    assert.deepEqual([audits[0][0], audits[0][2], audits[0][3]], ['mcp.token.revoke', body.record.id, 'alice']);
    const list = await api.call('GET', '/api/mcp-tokens', { user: ALICE });
    assert.ok(list.body.tokens[0].revokedAt, 'a revoked token stays listed, marked revoked');
    assert.equal((await api.call('DELETE', `/api/mcp-tokens/${body.record.id}`, { user: ALICE })).status, 204, 'revoking twice is fine');
});

test('DELETE of somebody else\'s or an unknown token is a 404 and changes nothing', async () => {
    const { body } = await create({ name: 'alices', scopes: { studio: { level: 'read' } } });
    audits.length = 0;
    assert.equal((await api.call('DELETE', `/api/mcp-tokens/${body.record.id}`, { user: BOB })).status, 404);
    assert.equal((await api.call('DELETE', '/api/mcp-tokens/no-such-id', { user: ALICE })).status, 404);
    assert.equal(rows.get(body.record.id).revokedAt, null);
    assert.equal(audits.length, 0);
});

test('a member with no home org gets a token bound to the org their group belongs to', async () => {
    accounts.set('carol', { id: 'carol', organizationId: '', groups: ['g1', 'g2'] });
    const CAROL = { id: 'carol', organizationId: '', role: 'user' };
    const res = await create({ name: 'group member', scopes: { studio: { level: 'read' } } }, CAROL);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.record.orgId, 'org7', 'the first group org, deterministically');
    assert.equal(audits[0][6], 'org7', 'the audit row names that org');
});

test('if the groups cannot be read no token is minted (never one without an org)', async () => {
    accounts.set('carol', { id: 'carol', organizationId: '', groups: ['g1'] });
    groupsError = new Error('db down');
    const res = await create({ name: 'x', scopes: { studio: { level: 'read' } } }, { id: 'carol', organizationId: '', role: 'user' });
    assert.equal(res.status, 500);
    assert.equal(rows.size, 0);
});

// ── A token never grants more than its creator can do ──────────────────────

const eligibleWith = (patch) => async () => ({ ...ALL_ELIGIBLE(), ...patch });

test('GET returns the caller\'s eligibility and the public base URL', async () => {
    mcpTokensRouter._test.setEligibility(eligibleWith({ studio: { available: false, reason: 'no_access', canWrite: false } }));
    const res = await api.call('GET', '/api/mcp-tokens', { user: ALICE });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.eligibility.studio, { available: false, reason: 'no_access', canWrite: false });
    assert.deepEqual(res.body.eligibility.policy, { allowed: true });
    assert.equal(typeof res.body.mcpBaseUrl, 'string');
});

test('GET uses PUBLIC_BASE_URL for mcpBaseUrl when it is set', async () => {
    const before = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://flow.example.org/';
    try {
        const res = await api.call('GET', '/api/mcp-tokens', { user: ALICE });
        assert.equal(res.body.mcpBaseUrl, 'https://flow.example.org');
    } finally {
        if (before === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = before;
    }
});

for (const [server, scope, patch] of [
    ['automations', { level: 'write' }, { automations: { available: false, reason: 'no_access' } }],
    ['studio', { level: 'read' }, { studio: { available: false, reason: 'no_access', canWrite: false } }],
    ['cms', { level: 'read', publish: false }, { cms: { available: false, reason: 'no_access', canPublish: false } }],
    ['automations', { level: 'write' }, { automations: { available: false, reason: 'not_enabled' } }],
]) {
    test(`POST refuses ${server} (${patch[server].reason}) with 403 scope_not_permitted and mints nothing`, async () => {
        mcpTokensRouter._test.setEligibility(eligibleWith(patch));
        const res = await create({ name: 'x', scopes: { integrations: { level: 'read' }, [server]: scope } });
        assert.equal(res.status, 403, res.text);
        assert.equal(res.body.code, 'scope_not_permitted');
        assert.match(res.body.error, /yourself|switched on/);
        assert.equal(rows.size, 0);
        assert.equal(audits.length, 0);
    });
}

test('POST refuses studio write when the caller cannot write, but allows read', async () => {
    mcpTokensRouter._test.setEligibility(eligibleWith({ studio: { available: true, canWrite: false } }));
    assert.equal((await create({ name: 'w', scopes: { studio: { level: 'write' } } })).status, 403);
    assert.equal((await create({ name: 'r', scopes: { studio: { level: 'read' } } })).status, 201);
});

test('POST refuses cms publish when the caller cannot publish, but allows cms without it', async () => {
    mcpTokensRouter._test.setEligibility(eligibleWith({ cms: { available: true, canPublish: false } }));
    const refused = await create({ name: 'p', scopes: { cms: { level: 'write', publish: true } } });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'scope_not_permitted');
    assert.equal((await create({ name: 'np', scopes: { cms: { level: 'write' } } })).status, 201);
});

test('POST refuses with 403 mcp_not_allowed when the policy keeps the caller off MCP', async () => {
    for (const reason of ['disabled', 'user_not_allowed', 'unavailable']) {
        mcpTokensRouter._test.setEligibility(eligibleWith({ policy: { allowed: false, reason } }));
        const res = await create({ name: 'x', scopes: { integrations: { level: 'read' } } });
        assert.equal(res.status, 403, res.text);
        assert.equal(res.body.code, 'mcp_not_allowed');
    }
    assert.equal(rows.size, 0);
});

test('POST allows every server the caller may use', async () => {
    const res = await create({ name: 'all', scopes: {
        integrations: { level: 'write' }, automations: { level: 'write' },
        studio: { level: 'write' }, cms: { level: 'write', publish: true },
    } });
    assert.equal(res.status, 201, res.text);
});

test('the real eligibility check reads the org policy: a restrictive org policy refuses the token', async () => {
    mcpTokensRouter._test.setEligibility(null);
    secrets.set('org_org1_mcp_access', JSON.stringify({ enabled: true, allowedUsers: { mode: 'users', userIds: ['bob'] } }));
    const res = await create({ name: 'x', scopes: { integrations: { level: 'read' } } });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body.code, 'mcp_not_allowed');
    assert.equal((await create({ name: 'x', scopes: { integrations: { level: 'read' } } }, BOB)).status, 201);
});

// ── Switching a token off and on ───────────────────────────────────────────

const patch = (id, body, user = ALICE) => api.call('PATCH', `/api/mcp-tokens/${id}`, { body, user });

test('PATCH switches a token off and on, audits it, and never changes the secret', async () => {
    const { body } = await create({ name: 'mine', scopes: { studio: { level: 'read' } } });
    audits.length = 0;
    const off = await patch(body.record.id, { enabled: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.body.record.enabled, false);
    assert.ok(off.body.record.disabledAt);
    assert.equal(JSON.stringify(off.body).includes(body.token.split('_')[2]), false);
    assert.equal((await api.call('GET', '/api/mcp-tokens', { user: ALICE })).body.tokens[0].enabled, false);
    const on = await patch(body.record.id, { enabled: true });
    assert.equal(on.body.record.enabled, true);
    assert.equal(on.body.record.disabledAt, null);
    assert.deepEqual(audits.map((a) => [a[0], a[2], a[3], a[6]]), [
        ['mcp.token.disable', body.record.id, 'alice', 'org1'],
        ['mcp.token.enable', body.record.id, 'alice', 'org1'],
    ]);
});

test('PATCH of somebody else\'s or an unknown token is a 404 and changes nothing', async () => {
    const { body } = await create({ name: 'alices', scopes: { studio: { level: 'read' } } });
    audits.length = 0;
    assert.equal((await patch(body.record.id, { enabled: false }, BOB)).status, 404);
    assert.equal((await patch('nope', { enabled: false })).status, 404);
    assert.equal(rows.get(body.record.id).disabledAt, null);
    assert.equal(audits.length, 0);
});

test('PATCH of a revoked token is a 400 token_revoked', async () => {
    const { body } = await create({ name: 'gone', scopes: { studio: { level: 'read' } } });
    await api.call('DELETE', `/api/mcp-tokens/${body.record.id}`, { user: ALICE });
    audits.length = 0;
    const res = await patch(body.record.id, { enabled: true });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.code, 'token_revoked');
    assert.equal(audits.length, 0);
});

test('PATCH takes only a boolean enabled', async () => {
    const { body } = await create({ name: 'x', scopes: { studio: { level: 'read' } } });
    for (const bad of [undefined, {}, { enabled: 'yes' }, { enabled: false, name: 'y' }, { revokedAt: null }]) {
        const res = await patch(body.record.id, bad);
        assert.equal(res.status, 400, `${JSON.stringify(bad)} -> ${res.status}`);
    }
    assert.equal((await api.call('PATCH', `/api/mcp-tokens/${body.record.id}`, { user: null, body: { enabled: false } })).status, 401);
});
