'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const policyMod = require('./orgPolicy');
const { getOrgMcpPolicy, saveOrgMcpPolicy, normalizePolicy, userAllowedByPolicy, DEFAULT_POLICY, _test } = policyMod;

let secrets;
let audits;
function install() {
    secrets = new Map();
    audits = [];
    _test.setDeps({
        configStore: {
            getSecret: async (k) => secrets.get(k) ?? null,
            setSecret: async (k, v, ctx) => { secrets.set(k, v); secrets.set(`${k}:ctx`, ctx); },
        },
        userStore: { logAccessAudit: async (...args) => { audits.push(args); } },
    });
}
test.beforeEach(install);
test.after(() => _test.setDeps({}));

test('no stored policy is the open default, which equals today\'s behaviour', async () => {
    assert.deepEqual(await getOrgMcpPolicy('org1'), {
        enabled: true, ipAllowlist: [], allowedUsers: { mode: 'all', roles: [], userIds: [] }, rejectLegacyTokens: false,
    });
    assert.deepEqual(await getOrgMcpPolicy(null), DEFAULT_POLICY);
});

test('the default is not shared: changing a returned policy does not change the next one', async () => {
    const a = await getOrgMcpPolicy('org1');
    a.ipAllowlist.push('1.2.3.4');
    assert.deepEqual((await getOrgMcpPolicy('org1')).ipAllowlist, []);
});

test('save stores under org_<orgId>_mcp_access, canonicalised, and audits mcp.policy.update', async () => {
    const saved = await saveOrgMcpPolicy('org1', {
        enabled: true, ipAllowlist: [' 203.0.113.0/24 ', '2001:db8::/32'],
        allowedUsers: { mode: 'roles', roles: ['org_admin'], userIds: [] }, rejectLegacyTokens: true,
    }, 'admin1');
    assert.deepEqual(saved.ipAllowlist, ['203.0.113.0/24', '2001:db8::/32']);
    assert.ok(secrets.has('org_org1_mcp_access'));
    assert.deepEqual(JSON.parse(secrets.get('org_org1_mcp_access')), saved);
    assert.deepEqual(await getOrgMcpPolicy('org1'), saved);
    assert.equal(audits.length, 1);
    const [action, targetType, targetId, actor, before, after, orgId] = audits[0];
    assert.deepEqual([action, targetType, targetId, actor, orgId], ['mcp.policy.update', 'organization', 'org1', 'admin1', 'org1']);
    assert.deepEqual(before, DEFAULT_POLICY);
    assert.deepEqual(after, saved);
});

test('save refuses invalid policies with a 400 and writes nothing', async () => {
    const bad = [
        null, 'x', [], { enabled: 'yes' }, { rejectLegacyTokens: 1 }, { surprise: true },
        { ipAllowlist: ['nope'] }, { ipAllowlist: 'x' },
        { allowedUsers: { mode: 'everyone' } }, { allowedUsers: { mode: 'roles', roles: [] } }, { allowedUsers: { mode: 'users', userIds: [] } },
        { allowedUsers: { mode: 'all', extra: 1 } },
    ];
    for (const b of bad) {
        await assert.rejects(saveOrgMcpPolicy('org1', b, 'a'), (e) => e.status === 400, JSON.stringify(b));
    }
    await assert.rejects(saveOrgMcpPolicy(null, {}, 'a'), (e) => e.status === 400);
    assert.equal(secrets.size, 0);
    assert.equal(audits.length, 0);
});

test('a partial document is filled with the defaults', () => {
    assert.deepEqual(normalizePolicy({ enabled: false }), {
        enabled: false, ipAllowlist: [], allowedUsers: { mode: 'all', roles: [], userIds: [] }, rejectLegacyTokens: false,
    });
});

test('a stored policy that cannot be read throws instead of falling back to open', async () => {
    secrets.set('org_org1_mcp_access', '{not json');
    await assert.rejects(getOrgMcpPolicy('org1'), /could not be read/);
    secrets.set('org_org1_mcp_access', JSON.stringify({ enabled: 'maybe' }));
    await assert.rejects(getOrgMcpPolicy('org1'), /could not be read/);
});

test('userAllowedByPolicy: modes all, roles and users', () => {
    const member = { id: 'u1', orgRole: 'member' };
    const admin = { id: 'u2', orgRole: 'admin' }; // legacy spelling of org_admin
    const allowed = (allowedUsers, u) => userAllowedByPolicy({ allowedUsers }, u);
    assert.equal(allowed({ mode: 'all' }, member), true);
    assert.equal(allowed({ mode: 'roles', roles: ['member'] }, member), true);
    assert.equal(allowed({ mode: 'roles', roles: ['org_admin'] }, member), false);
    assert.equal(allowed({ mode: 'roles', roles: ['org_admin'] }, admin), true);
    assert.equal(allowed({ mode: 'roles', roles: ['member'] }, { id: 'u3' }), false, 'no role never matches');
    assert.equal(allowed({ mode: 'users', userIds: ['u1'] }, member), true);
    assert.equal(allowed({ mode: 'users', userIds: ['u1'] }, admin), false);
    assert.equal(allowed({ mode: 'users', userIds: ['u1'] }, null), false);
    assert.equal(allowed({ mode: 'weird' }, member), false, 'an unknown mode fails closed');
});
