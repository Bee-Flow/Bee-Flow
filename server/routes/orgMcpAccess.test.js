'use strict';

/**
 * /api/org/mcp-access: the organisation's MCP access policy, org admins only.
 * Run: node --test routes/orgMcpAccess.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../core/http/routeHarness');
h.recordDb(); // keep any store that starts its schema on load off a real database
const orgPolicy = require('../auth/mcpAccess/orgPolicy');

const secrets = new Map();
const audits = [];
orgPolicy._test.setDeps({
    configStore: {
        getSecret: async (k) => secrets.get(k) ?? null,
        setSecret: async (k, v) => { secrets.set(k, v); },
    },
    userStore: { logAccessAudit: async (...args) => { audits.push(args); } },
});

// The real gate needs a database. Stand in for it with the same contract:
// org admins pass and get req.primaryOrgId, everyone else is a 403.
h.openGates({
    requirePrimaryOrgAdmin: () => (req, res, next) => {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        if (req.session.user.orgRole !== 'org_admin') return res.status(403).json({ error: 'Organization admin access required' });
        req.primaryOrgId = req.session.user.organizationId;
        return next();
    },
});
const api = h.serve('/api/org/mcp-access', require('./orgMcpAccess'));
test.after(async () => { await api.close(); orgPolicy._test.setDeps({}); });
test.beforeEach(() => { secrets.clear(); audits.length = 0; });

const ADMIN = { id: 'admin1', organizationId: 'org1', orgRole: 'org_admin', role: 'user' };
const MEMBER = { id: 'u1', organizationId: 'org1', orgRole: 'member', role: 'user' };

test('members and anonymous callers are refused on both verbs', async () => {
    assert.equal((await api.call('GET', '/api/org/mcp-access', { user: MEMBER })).status, 403);
    assert.equal((await api.call('PUT', '/api/org/mcp-access', { user: MEMBER, body: {} })).status, 403);
    assert.equal((await api.call('GET', '/api/org/mcp-access', { user: null })).status, 401);
    assert.equal(secrets.size, 0);
});

test('GET returns the default policy and the caller\'s IP', async () => {
    const res = await api.call('GET', '/api/org/mcp-access', { user: ADMIN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.policy, {
        enabled: true, ipAllowlist: [], allowedUsers: { mode: 'all', roles: [], userIds: [] }, rejectLegacyTokens: false,
    });
    assert.match(res.body.callerIp, /127\.0\.0\.1/);
});

test('PUT saves the policy for the admin\'s own org, returns it, and GET reads it back', async () => {
    const body = {
        enabled: true, ipAllowlist: ['203.0.113.0/24'],
        allowedUsers: { mode: 'roles', roles: ['org_admin', 'member'], userIds: [] }, rejectLegacyTokens: true,
    };
    const put = await api.call('PUT', '/api/org/mcp-access', { user: ADMIN, body });
    assert.equal(put.status, 200, put.text);
    assert.deepEqual(put.body, { policy: body });
    assert.ok(secrets.has('org_org1_mcp_access'));
    assert.equal(audits.length, 1);
    assert.deepEqual([audits[0][0], audits[0][3], audits[0][6]], ['mcp.policy.update', 'admin1', 'org1']);
    const get = await api.call('GET', '/api/org/mcp-access', { user: ADMIN });
    assert.deepEqual(get.body.policy, body);
});

test('PUT refuses an invalid policy with a 400 and stores nothing', async () => {
    const bad = [
        { ipAllowlist: ['nope'] },
        { allowedUsers: { mode: 'roles', roles: [] } },
        { allowedUsers: { mode: 'everyone' } },
        { enabled: 'yes' },
        { surprise: 1 },
    ];
    for (const body of bad) {
        const res = await api.call('PUT', '/api/org/mcp-access', { user: ADMIN, body });
        assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
        assert.ok(res.body.error);
    }
    assert.equal(secrets.size, 0);
    assert.equal(audits.length, 0);
});

test('an admin can only reach their own org: there is no org id in the request', async () => {
    const other = { ...ADMIN, id: 'admin2', organizationId: 'org2' };
    await api.call('PUT', '/api/org/mcp-access', { user: other, body: { enabled: false } });
    assert.ok(secrets.has('org_org2_mcp_access'));
    assert.equal(secrets.has('org_org1_mcp_access'), false);
});
