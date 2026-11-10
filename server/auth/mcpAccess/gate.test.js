'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAccess, evaluateAccessForOrgs, gateRequest, rpcDenied } = require('./gate');
const { MAX_BATCH_SIZE, batchTooLarge, rpcBatchTooLarge } = require('./batch');
const { LEGACY_SCOPES } = require('./scopes');
const { DEFAULT_POLICY } = require('./orgPolicy');
const { isActiveAccount } = require('../accountStatusGate');

const NOW = Date.parse('2026-10-10T12:00:00Z');
const IN_LIST = '203.0.113.7';

const token = (over = {}) => ({
    id: 't1', userId: 'u1', name: 'ci', scopes: { studio: { level: 'write' } }, ipAllowlist: [],
    expiresAt: null, revokedAt: null, legacy: false, ...over,
});
const policy = (over = {}) => ({ ...structuredClone(DEFAULT_POLICY), ...over });
const user = (over = {}) => ({ id: 'u1', orgRole: 'member', organizationId: 'org1', status: 'active', ...over });

const CASES = [
    ['ok', {}, { ok: true }],
    ['ok with an IP inside both lists', { policy: policy({ ipAllowlist: ['203.0.113.0/24'] }), token: token({ ipAllowlist: ['203.0.113.7'] }) }, { ok: true }],
    ['no token', { token: null }, { status: 401, reason: 'token_unknown' }],
    ['revoked token', { token: token({ revokedAt: '2026-10-01T00:00:00Z' }) }, { status: 401, reason: 'token_revoked' }],
    ['token switched off by its owner', { token: token({ disabledAt: '2026-10-09T00:00:00Z' }) }, { status: 401, reason: 'token_disabled' }],
    ['token switched back on', { token: token({ disabledAt: null }) }, { ok: true }],
    ['expired token', { token: token({ expiresAt: '2026-10-10T11:59:59Z' }) }, { status: 401, reason: 'token_expired' }],
    ['token that expires in the future', { token: token({ expiresAt: '2026-10-10T12:00:01Z' }) }, { ok: true }],
    ['token expiring exactly now is expired', { token: token({ expiresAt: '2026-10-10T12:00:00Z' }) }, { status: 401, reason: 'token_expired' }],
    ['user gone', { user: null, accountActive: false }, { status: 403, reason: 'user_missing' }],
    ['inactive account', { accountActive: false }, { status: 403, reason: 'account_inactive' }],
    ['token minted in another org', { token: token({ orgId: 'org2' }) }, { status: 403, reason: 'token_org_mismatch' }],
    ['token minted in the user\'s org', { token: token({ orgId: 'org1' }) }, { ok: true }],
    ['policy disabled', { policy: policy({ enabled: false }) }, { status: 403, reason: 'mcp_disabled' }],
    ['mode roles, role listed', { policy: policy({ allowedUsers: { mode: 'roles', roles: ['member'], userIds: [] } }) }, { ok: true }],
    ['mode roles, role not listed', { policy: policy({ allowedUsers: { mode: 'roles', roles: ['org_admin'], userIds: [] } }) }, { status: 403, reason: 'user_not_allowed' }],
    ['mode roles, legacy admin role counts as org_admin', { user: user({ orgRole: 'admin' }), policy: policy({ allowedUsers: { mode: 'roles', roles: ['org_admin'], userIds: [] } }) }, { ok: true }],
    ['mode users, user listed', { policy: policy({ allowedUsers: { mode: 'users', roles: [], userIds: ['u1'] } }) }, { ok: true }],
    ['mode users, user not listed', { policy: policy({ allowedUsers: { mode: 'users', roles: [], userIds: ['u2'] } }) }, { status: 403, reason: 'user_not_allowed' }],
    ['legacy token accepted by default', { token: token({ id: null, legacy: true, scopes: LEGACY_SCOPES }) }, { ok: true }],
    ['legacy token rejected by policy', { token: token({ id: null, legacy: true, scopes: LEGACY_SCOPES }), policy: policy({ rejectLegacyTokens: true }) }, { status: 403, reason: 'legacy_rejected' }],
    ['named token unaffected by rejectLegacyTokens', { policy: policy({ rejectLegacyTokens: true }) }, { ok: true }],
    ['IP outside the org list', { policy: policy({ ipAllowlist: ['198.51.100.0/24'] }) }, { status: 403, reason: 'ip_outside_org_list' }],
    ['IP outside the token list', { token: token({ ipAllowlist: ['198.51.100.0/24'] }) }, { status: 403, reason: 'ip_outside_token_list' }],
    ['strictest wins: in the org list, outside the token list', { policy: policy({ ipAllowlist: ['203.0.113.0/24'] }), token: token({ ipAllowlist: ['198.51.100.0/24'] }) }, { status: 403, reason: 'ip_outside_token_list' }],
    ['strictest wins: in the token list, outside the org list', { policy: policy({ ipAllowlist: ['198.51.100.0/24'] }), token: token({ ipAllowlist: ['203.0.113.0/24'] }) }, { status: 403, reason: 'ip_outside_org_list' }],
    ['IPv4-mapped client address inside an IPv4 list', { ip: '::ffff:203.0.113.7', policy: policy({ ipAllowlist: ['203.0.113.0/24'] }) }, { ok: true }],
    ['unknown client address with a list', { ip: undefined, policy: policy({ ipAllowlist: ['203.0.113.0/24'] }) }, { status: 403, reason: 'ip_outside_org_list' }],
    ['server the token has', { server: 'studio' }, { ok: true }],
    ['server the token lacks', { server: 'cms' }, { status: 403, reason: 'server_not_in_scope' }],
    ['no policy loaded', { policy: null }, { status: 403, reason: 'mcp_disabled' }],
];

for (const [name, over, expected] of CASES) {
    test(`evaluateAccess: ${name}`, () => {
        const result = evaluateAccess({
            token: token(), user: user(), accountActive: true, policy: policy(), ip: IN_LIST, now: NOW, ...over,
        });
        if (expected.ok) return assert.deepEqual(result, { ok: true });
        assert.deepEqual(result, { ok: false, status: expected.status, reason: expected.reason });
    });
}

test('the order: a dead token is reported before an inactive account, which comes before policy and IP', () => {
    const all = {
        token: token({ revokedAt: '2026-10-01T00:00:00Z' }), accountActive: false,
        policy: policy({ enabled: false, ipAllowlist: ['198.51.100.0/24'] }), now: NOW, ip: IN_LIST, user: user(),
    };
    assert.equal(evaluateAccess(all).reason, 'token_revoked');
    assert.equal(evaluateAccess({ ...all, token: token() }).reason, 'account_inactive');
    assert.equal(evaluateAccess({ ...all, token: token(), accountActive: true }).reason, 'mcp_disabled');
    assert.equal(evaluateAccess({ ...all, token: token(), accountActive: true, policy: policy({ ipAllowlist: ['198.51.100.0/24'] }) }).reason, 'ip_outside_org_list');
});

test('isActiveAccount: active, no status and a missing row', () => {
    assert.equal(isActiveAccount({ status: 'active' }), true);
    assert.equal(isActiveAccount({}), true, 'a row from before the status column');
    assert.equal(isActiveAccount({ status: 'suspended' }), false);
    assert.equal(isActiveAccount({ status: 'offboarded' }), false);
    assert.equal(isActiveAccount({ status: 'pending' }), false);
    assert.equal(isActiveAccount(null), false);
});

// ── gateRequest ─────────────────────────────────────────────────────────────

function fakeDeps(over = {}) {
    const touched = [];
    return {
        touched,
        deps: {
            getUser: async () => user(),
            getOrgMcpPolicy: async () => policy(),
            resolveOrgs: async (u) => ({ primary: u.organizationId || null, all: u.organizationId ? [u.organizationId] : [] }),
            rateLimitUser: async () => ({ ok: true }),
            findByPresented: async () => token(),
            authenticateLegacy: async () => null,
            touchLastUsed: (id) => touched.push(id),
            rateLimit: async () => ({ ok: true }),
            ...over,
        },
    };
}

const req = (authorization, ip = IN_LIST) => ({ headers: { authorization }, ip });
const NAMED = `Bearer bfmcp_${'a'.repeat(32)}_${'b'.repeat(64)}`;

test('gateRequest: a named token resolves to its user, org and scopes, and records use', async () => {
    const { deps, touched } = fakeDeps();
    const out = await gateRequest(req(NAMED), 'studio', deps);
    assert.equal(out.ok, true);
    assert.equal(out.user.id, 'u1');
    assert.equal(out.orgId, 'org1');
    assert.deepEqual(out.token, { id: 't1', name: 'ci', scopes: { studio: { level: 'write' } }, legacy: false });
    assert.deepEqual(touched, ['t1']);
});

test('gateRequest: a legacy token gets the legacy scopes and is not touched', async () => {
    const { deps, touched } = fakeDeps({ authenticateLegacy: async () => 'u1' });
    const out = await gateRequest(req('Bearer bfmcp.dTE.' + 'a'.repeat(64)), 'integrations', deps);
    assert.equal(out.ok, true);
    assert.equal(out.token.legacy, true);
    assert.equal(out.token.id, null);
    assert.equal(out.token.scopes, LEGACY_SCOPES);
    assert.deepEqual(touched, []);
});

test('gateRequest: the legacy path is never tried for a bfmcp_ string', async () => {
    let legacyCalls = 0;
    const { deps } = fakeDeps({ findByPresented: async () => null, authenticateLegacy: async () => { legacyCalls++; return 'u1'; } });
    const out = await gateRequest(req(NAMED), 'studio', deps);
    assert.deepEqual([out.ok, out.status], [false, 401]);
    assert.equal(legacyCalls, 0);
});

test('gateRequest: no header, garbage and unknown tokens are a 401', async () => {
    const { deps } = fakeDeps({ findByPresented: async () => null, authenticateLegacy: async () => null });
    for (const h of [undefined, '', 'Bearer nonsense', NAMED]) {
        const out = await gateRequest(req(h), 'studio', deps);
        assert.deepEqual([out.ok, out.status], [false, 401], String(h));
    }
});

test('gateRequest: a lookup that throws is a refusal, not a crash', async () => {
    const { deps } = fakeDeps({ findByPresented: async () => { throw new Error('db down'); } });
    assert.deepEqual((await gateRequest(req(NAMED), 'studio', deps)).status, 401);
    const { deps: d2 } = fakeDeps({ getOrgMcpPolicy: async () => { throw new Error('unreadable'); } });
    assert.deepEqual((await gateRequest(req(NAMED), 'studio', d2)).status, 403);
});

test('gateRequest: a suspended account is refused even with a good token', async () => {
    const { deps, touched } = fakeDeps({ getUser: async () => user({ status: 'suspended' }) });
    const out = await gateRequest(req(NAMED), 'studio', deps);
    assert.deepEqual([out.ok, out.status, out.reason], [false, 403, 'account_inactive']);
    assert.deepEqual(touched, []);
});

test('gateRequest: the org policy is read for the user\'s current org', async () => {
    let asked;
    const { deps } = fakeDeps({ getOrgMcpPolicy: async (orgId) => { asked = orgId; return policy(); } });
    await gateRequest(req(NAMED), 'studio', deps);
    assert.equal(asked, 'org1');
});

test('gateRequest: a token for a server it does not hold is a 403', async () => {
    const { deps } = fakeDeps();
    const out = await gateRequest(req(NAMED), 'cms', deps);
    assert.deepEqual([out.ok, out.status, out.reason], [false, 403, 'server_not_in_scope']);
});

test('gateRequest: a member with no home org is held to the policy of their group\'s org', async () => {
    const groupOnly = user({ organizationId: '' });
    const asked = [];
    const { deps, touched } = fakeDeps({
        getUser: async () => groupOnly,
        resolveOrgs: async () => ({ primary: 'orgG', all: ['orgG'] }),
        getOrgMcpPolicy: async (orgId) => { asked.push(orgId); return policy({ enabled: false }); },
    });
    const out = await gateRequest(req(NAMED), 'studio', deps);
    assert.deepEqual([out.ok, out.status, out.reason], [false, 403, 'mcp_disabled']);
    assert.deepEqual(asked, ['orgG'], 'the group org\'s policy was loaded, not the open default for "no org"');
    assert.deepEqual(touched, []);
    // The same member passes when that org's policy lets them in; the org reported is the group's.
    const { deps: open } = fakeDeps({
        getUser: async () => groupOnly,
        resolveOrgs: async () => ({ primary: 'orgG', all: ['orgG'] }),
        getOrgMcpPolicy: async () => policy({ ipAllowlist: ['203.0.113.0/24'] }),
    });
    const ok = await gateRequest(req(NAMED), 'studio', open);
    assert.equal(ok.ok, true);
    assert.equal(ok.orgId, 'orgG');
    const outside = await gateRequest(req(NAMED, '198.51.100.1'), 'studio', open);
    assert.deepEqual([outside.ok, outside.reason], [false, 'ip_outside_org_list']);
});

test('gateRequest: with several orgs every policy applies and the strictest wins', async () => {
    const policies = { orgA: policy(), orgB: policy({ allowedUsers: { mode: 'users', roles: [], userIds: ['somebody-else'] } }) };
    const { deps } = fakeDeps({
        getUser: async () => user({ organizationId: '' }),
        resolveOrgs: async () => ({ primary: 'orgA', all: ['orgA', 'orgB'] }),
        getOrgMcpPolicy: async (orgId) => policies[orgId],
    });
    const out = await gateRequest(req(NAMED), 'studio', deps);
    assert.deepEqual([out.ok, out.status, out.reason], [false, 403, 'user_not_allowed']);
});

test('gateRequest: org resolution that fails denies, it never falls back to the open default', async () => {
    let policyAsked = false;
    const { deps } = fakeDeps({
        resolveOrgs: async () => { throw new Error('groups unreadable'); },
        getOrgMcpPolicy: async () => { policyAsked = true; return policy(); },
    });
    const out = await gateRequest(req(NAMED), 'studio', deps);
    assert.deepEqual([out.ok, out.status, out.reason], [false, 403, 'lookup_failed']);
    assert.equal(policyAsked, false);
});

test('gateRequest: a token bound to an org the user no longer belongs to is refused (group orgs count)', async () => {
    const { deps } = fakeDeps({
        findByPresented: async () => token({ orgId: 'orgG' }),
        getUser: async () => user({ organizationId: '' }),
        resolveOrgs: async () => ({ primary: 'orgG', all: ['orgG'] }),
    });
    assert.equal((await gateRequest(req(NAMED), 'studio', deps)).ok, true);
    const { deps: moved } = fakeDeps({
        findByPresented: async () => token({ orgId: 'orgG' }),
        getUser: async () => user({ organizationId: '' }),
        resolveOrgs: async () => ({ primary: 'orgZ', all: ['orgZ'] }),
    });
    assert.equal((await gateRequest(req(NAMED), 'studio', moved)).reason, 'token_org_mismatch');
});

test('evaluateAccessForOrgs: first refusal wins, an empty list denies', () => {
    const base = { token: token(), user: user(), accountActive: true, ip: IN_LIST, now: NOW };
    assert.equal(evaluateAccessForOrgs({ ...base, policies: [policy(), policy()] }).ok, true);
    assert.equal(evaluateAccessForOrgs({ ...base, policies: [policy(), policy({ enabled: false })] }).reason, 'mcp_disabled');
    assert.equal(evaluateAccessForOrgs({ ...base, policies: [] }).ok, false);
});

test('gateRequest: a batch is charged one unit per message, to the token and to the user', async () => {
    const charged = [];
    const { deps } = fakeDeps({
        rateLimit: async (key, cost) => { charged.push(['token', key, cost]); return { ok: true }; },
        rateLimitUser: async (key, cost) => { charged.push(['user', key, cost]); return { ok: true }; },
    });
    await gateRequest({ ...req(NAMED), body: [{}, {}, {}] }, 'studio', deps);
    await gateRequest({ ...req(NAMED), body: { id: 1 } }, 'studio', deps);
    await gateRequest(req(NAMED), 'studio', deps);
    assert.deepEqual(charged, [
        ['token', 't1', 3], ['user', 'user:u1', 3],
        ['token', 't1', 1], ['user', 'user:u1', 1],
        ['token', 't1', 1], ['user', 'user:u1', 1],
    ]);
});

test('gateRequest: a huge batch is charged at most one past the cap, so the limiter always has an answer', async () => {
    const costs = [];
    const { deps } = fakeDeps({ rateLimit: async (key, cost) => { costs.push(cost); return { ok: true }; } });
    await gateRequest({ ...req(NAMED), body: new Array(5000).fill({}) }, 'studio', deps);
    assert.deepEqual(costs, [MAX_BATCH_SIZE + 1]);
});

test('gateRequest: the per-user budget refuses even when the token budget has room', async () => {
    const { deps, touched } = fakeDeps({ rateLimitUser: async () => ({ ok: false, retryAfter: 9 }) });
    const out = await gateRequest(req(NAMED), 'studio', deps);
    assert.deepEqual([out.ok, out.status, out.retryAfter], [false, 429, 9]);
    assert.deepEqual(touched, []);
});

test('the real limiters: 300 a minute per user across tokens, and a batch spends one unit per message', async () => {
    const { _test } = require('./gate');
    const user = `u-${Date.now()}`;
    for (let i = 0; i < 15; i++) assert.equal((await _test.userRateLimitCheck(user, 20)).ok, true, `batch ${i + 1}`);
    assert.equal((await _test.userRateLimitCheck(user, 1)).ok, false, '300 units are spent');
    const tok = `tok-${Date.now()}`;
    assert.equal((await _test.rateLimitCheck(tok, 100)).ok, true);
    assert.equal((await _test.rateLimitCheck(tok, 21)).ok, false, '121 units in a minute is over the token limit');
    assert.equal((await _test.rateLimitCheck(tok, 20)).ok, true);
});

test('batches: more than 20 messages is an Invalid Request and nothing is run', () => {
    assert.equal(MAX_BATCH_SIZE, 20);
    assert.equal(batchTooLarge(new Array(20).fill({})), false);
    assert.equal(batchTooLarge(new Array(21).fill({})), true);
    assert.equal(batchTooLarge({ id: 1 }), false);
    assert.equal(batchTooLarge(undefined), false);
    const sent = {};
    const res = { status(c) { sent.status = c; return this; }, json(b) { sent.body = b; return this; } };
    rpcBatchTooLarge(res);
    assert.equal(sent.status, 400);
    assert.equal(sent.body.id, null);
    assert.equal(sent.body.error.code, -32600);
    assert.match(sent.body.error.message, /at most 20/);
});

test('gateRequest: the rate limit refuses with a 429 and a retry hint', async () => {
    const keys = [];
    const { deps, touched } = fakeDeps({ rateLimit: async (key) => { keys.push(key); return { ok: false, retryAfter: 17 }; } });
    const out = await gateRequest(req(NAMED), 'studio', deps);
    assert.deepEqual([out.ok, out.status, out.retryAfter], [false, 429, 17]);
    assert.deepEqual(keys, ['t1']);
    assert.deepEqual(touched, []);
});

test('gateRequest: the rate limit is keyed on the token id, or the user for a legacy token', async () => {
    const keys = [];
    const { deps } = fakeDeps({ authenticateLegacy: async () => 'u9', rateLimit: async (k) => { keys.push(k); return { ok: true }; } });
    await gateRequest(req('Bearer bfmcp.x.y'), 'studio', deps);
    assert.deepEqual(keys, ['legacy:u9']);
});

test('gateRequest: the real rate limiter admits 120 requests a minute per token and then refuses', async () => {
    const { _test } = require('./gate');
    const key = `test-${Date.now()}`;
    for (let i = 0; i < 120; i++) assert.equal((await _test.rateLimitCheck(key)).ok, true, `request ${i + 1}`);
    const refused = await _test.rateLimitCheck(key);
    assert.equal(refused.ok, false);
    assert.ok(refused.retryAfter >= 1);
    assert.equal((await _test.rateLimitCheck(`${key}-other`)).ok, true, 'another token has its own budget');
});

test('rpcDenied: a generic JSON-RPC error that does not name the failed check', () => {
    const sent = [];
    const res = {
        headers: {},
        set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.code = c; return this; },
        json(b) { sent.push(b); return this; },
    };
    rpcDenied(res, 401, 7);
    assert.equal(res.code, 401);
    assert.equal(res.headers['WWW-Authenticate'], 'Bearer realm="bee-flow"');
    assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 7, error: { code: -32001, message: 'Unauthorized' } });

    const res403 = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    rpcDenied(res403, 403);
    assert.equal(res403.code, 403);
    assert.equal(res403.body.id, null);
    assert.equal(res403.body.error.message, 'Forbidden');
    assert.equal(res403.headers['WWW-Authenticate'], undefined);

    const res429 = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    rpcDenied(res429, 429, null, 12);
    assert.equal(res429.code, 429);
    assert.equal(res429.headers['Retry-After'], '12');
    assert.equal(rpcDenied({ set() { return this; }, status(c) { this.c = c; return this; }, json() { return this.c; } }, 500), 403, 'an unexpected status is a 403');
});
