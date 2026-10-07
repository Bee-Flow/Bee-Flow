'use strict';

/**
 * ISO27001-A.5.9-asset-inventory — an org-less published agent is the
 * 'default' bucket's asset, not every tenant's; personal knowledge bases are
 * attributed through their owner; and a count that FAILED (not a missing
 * table) warns instead of passing with "not enumerable yet".
 *
 * The check destructures getOne/getAll from db at require time, so both are
 * replaced on the real singleton BEFORE the check is required (the smoke
 * harness does the same). The doubles ignore the parameters on purpose: the
 * check must not depend on SQL alone for scoping a row it was handed.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a5-9-asset-inventory.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../../db');
const calls = [];
let agentRows = [];
let one = async () => ({ c: 0 });
db.getAll = async (sql, params) => { calls.push({ sql, params }); return agentRows; };
db.getOne = async (sql, params) => { calls.push({ sql, params }); return one(sql, params); };

const configStore = require('../../../stores/configStore');
configStore.getConfig = async (key) => (key === 'ai' ? { providers: [{ id: 'p1', type: 'anthropic' }] } : null);

const check = require('./a5-9-asset-inventory');

beforeEach(() => {
    calls.length = 0;
    agentRows = [{ id: 'g', organization_id: null, model: 'm1' }, { id: 'a', organization_id: 'org-a', model: 'm2' }];
    one = async () => ({ c: 0 });
});

test('an org-less published agent is not counted for a tenant', async () => {
    const r = await check.evaluate('org-a');
    assert.equal(r.evidence.published_agents, 1);
    assert.deepEqual(r.evidence.models.map(m => m.model), ['m2']);
    const agentQuery = calls.find(c => /FROM agents/.test(c.sql));
    assert.deepEqual(agentQuery.params, ['org-a']);
    assert.match(agentQuery.sql, /COALESCE\(NULLIF\(organization_id, ''\), 'default'\) = \$1/);
});

test('the default bucket counts the org-less agent and nothing of a tenant', async () => {
    const r = await check.evaluate('default');
    assert.equal(r.evidence.published_agents, 1);
    assert.deepEqual(r.evidence.models.map(m => m.model), ['m1']);
});

test('personal knowledge bases are attributed through their owner', async () => {
    await check.evaluate('org-a');
    const kb = calls.find(c => /FROM knowledge_bases/.test(c.sql));
    assert.match(kb.sql, /LEFT JOIN users u ON u\.id = kb\.tenant_id/);
    assert.match(kb.sql, /kb\.organization_id IS NULL AND COALESCE\(NULLIF\(u\."organizationId", ''\), 'default'\) = \$1/);
    assert.doesNotMatch(kb.sql, /OR organization_id IS NULL\s*$/m, 'not every personal KB for every org');
    assert.deepEqual(kb.params, ['org-a']);
});

test('a count that fails warns; a table that does not exist is "not enumerable yet"', async () => {
    one = async (sql) => {
        if (/knowledge_bases/.test(sql)) throw Object.assign(new Error('canceling statement'), { code: '57014' });
        return { c: 1 };
    };
    const broken = await check.evaluate('org-a');
    assert.equal(broken.status, 'warn');
    assert.deepEqual(broken.evidence.unreadable, [{ asset: 'knowledge_bases', error_code: '57014' }]);
    assert.match(broken.details, /knowledge_bases \(SQL state 57014\)/);

    one = async (sql) => {
        if (/mcp_servers/.test(sql)) throw Object.assign(new Error('x'), { code: '42P01' });
        return { c: 1 };
    };
    const young = await check.evaluate('org-a');
    assert.equal(young.status, 'pass');
    assert.deepEqual(young.evidence.not_enumerable, ['mcp_servers_enabled']);
});
