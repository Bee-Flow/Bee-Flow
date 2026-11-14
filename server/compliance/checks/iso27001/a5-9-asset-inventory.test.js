'use strict';

/**
 * ISO27001-A.5.9-asset-inventory — an org-less published agent is the
 * 'default' bucket's asset, not every tenant's; personal knowledge bases are
 * attributed through their owner; and a count that FAILED (not a missing
 * table) warns instead of passing with "not enumerable yet".
 *
 * Against a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js ladderPglite) behind db.js's pool. The AI
 * provider list comes from configStore, replaced on the singleton.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a5-9-asset-inventory.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads, hideTable } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

const { pg, close } = usePglitePool(ladderPglite());
const configStore = require('../../../stores/configStore');
configStore.getConfig = async (key) => (key === 'ai' ? { providers: [{ id: 'p1', type: 'anthropic' }] } : null);

const check = require('./a5-9-asset-inventory');
after(close);

beforeEach(async () => {
    await pg.exec(`DELETE FROM agents; DELETE FROM knowledge_bases; DELETE FROM users WHERE id LIKE 'ai_%'`);
    await insertRow(pg, 'agents', { id: 'g', name: 'g', owner_id: 'o', organization_id: null, model: 'm1', is_published: true });
    await insertRow(pg, 'agents', { id: 'a', name: 'a', owner_id: 'o', organization_id: 'org-a', model: 'm2', is_published: true });
    await insertRow(pg, 'agents', { id: 'draft', name: 'd', owner_id: 'o', organization_id: 'org-a', model: 'm3', is_published: false });
});

/** @param {string} id @param {string | null} org */
const user = (id, org) => insertRow(pg, 'users', { id, username: id, organizationId: org });
/** @param {string} tenant @param {string | null} org */
const kb = (tenant, org) => insertRow(pg, 'knowledge_bases', { tenant_id: tenant, name: 'kb', organization_id: org });

test('an org-less published agent is not counted for a tenant', async () => {
    const r = await check.evaluate('org-a');
    assert.equal(r.evidence.published_agents, 1);
    assert.deepEqual(r.evidence.models.map(m => m.model), ['m2']);
});

test('the default bucket counts the org-less agent and nothing of a tenant', async () => {
    const r = await check.evaluate('default');
    assert.equal(r.evidence.published_agents, 1);
    assert.deepEqual(r.evidence.models.map(m => m.model), ['m1']);
});

test('personal knowledge bases are attributed through their owner', async () => {
    await user('ai_a', 'org-a');
    await user('ai_b', 'org-b');
    await user('ai_none', null);
    await kb('ai_a', null);      // personal, owner in org-a
    await kb('ai_b', null);      // personal, owner in org-b
    await kb('ai_none', null);   // personal, owner in no org
    await kb('ai_b', 'org-a');   // an org-a base
    assert.equal((await check.evaluate('org-a')).evidence.knowledge_bases, 2, 'not every personal KB for every org');
    assert.equal((await check.evaluate('org-b')).evidence.knowledge_bases, 1);
    assert.equal((await check.evaluate('default')).evidence.knowledge_bases, 1);
});

test('a count that fails warns; a table that does not exist is "not enumerable yet"', async () => {
    const undo = await failReads(pg, 'knowledge_bases', '57014', 'canceling statement');
    let broken;
    try { broken = await check.evaluate('org-a'); } finally { await undo(); }
    assert.equal(broken.status, 'warn');
    assert.deepEqual(broken.evidence.unreadable, [{ asset: 'knowledge_bases', error_code: '57014' }]);
    assert.match(broken.details, /knowledge_bases \(SQL state 57014\)/);

    await kb('someone', 'org-a');
    const show = await hideTable(pg, 'mcp_servers');
    let young;
    try { young = await check.evaluate('org-a'); } finally { await show(); }
    assert.equal(young.status, 'pass');
    assert.deepEqual(young.evidence.not_enumerable, ['mcp_servers_enabled']);
});
