'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { instanceAllowlists } = require('./envAllowlist');
const { evaluateAccess } = require('./gate');
const { DEFAULT_POLICY } = require('./orgPolicy');

test('no env lists → nothing applies', () => {
    assert.deepEqual(instanceAllowlists('cms', {}), { ok: true, lists: [] });
});

test('global and per-server lists both apply; separators are comma, semicolon or space', () => {
    const out = instanceAllowlists('cms', { MCP_IP_ALLOWLIST: '10.0.0.0/8', CMS_MCP_IP_ALLOWLIST: '203.0.113.7; 198.51.100.0/24 2001:db8::/32' });
    assert.equal(out.ok, true);
    assert.equal(out.lists.length, 2);
    assert.equal(out.lists[1].length, 3);
});

test('a per-server list does not leak onto another server', () => {
    assert.deepEqual(instanceAllowlists('studio', { CMS_MCP_IP_ALLOWLIST: '203.0.113.7' }), { ok: true, lists: [] });
});

test('an unparseable list fails closed', () => {
    assert.deepEqual(instanceAllowlists('cms', { CMS_MCP_IP_ALLOWLIST: '203.0.113.7, not-an-ip' }), { ok: false });
});

const token = { id: 't1', userId: 'u1', scopes: { cms: { level: 'write' } }, ipAllowlist: [], legacy: false };
const user = { id: 'u1', organizationId: 'org1', orgRole: 'member', status: 'active' };
const base = { token, user, accountActive: true, policy: structuredClone(DEFAULT_POLICY), server: 'cms' };

test('evaluateAccess: inside the CMS env list passes', () => {
    assert.equal(evaluateAccess({ ...base, ip: '203.0.113.7', env: { CMS_MCP_IP_ALLOWLIST: '203.0.113.0/24' } }).ok, true);
});

test('evaluateAccess: outside the CMS env list is refused', () => {
    const out = evaluateAccess({ ...base, ip: '192.0.2.1', env: { CMS_MCP_IP_ALLOWLIST: '203.0.113.0/24' } });
    assert.deepEqual([out.ok, out.status, out.reason], [false, 403, 'ip_outside_instance_list']);
});

test('evaluateAccess: inside the per-server list but outside the global one is refused (strictest wins)', () => {
    const out = evaluateAccess({ ...base, ip: '203.0.113.7', env: { MCP_IP_ALLOWLIST: '10.0.0.0/8', CMS_MCP_IP_ALLOWLIST: '203.0.113.0/24' } });
    assert.equal(out.reason, 'ip_outside_instance_list');
});

test('evaluateAccess: an invalid env list refuses everyone', () => {
    const out = evaluateAccess({ ...base, ip: '203.0.113.7', env: { CMS_MCP_IP_ALLOWLIST: 'oops' } });
    assert.equal(out.reason, 'instance_allowlist_invalid');
});
