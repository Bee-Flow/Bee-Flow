// @typecheck
/**
 * withOrganizationNames (./agentOrgScope.mts): the names of the rows'
 * organisations are read for the distinct organisations only. A few are read
 * one by one; above MAX_ORG_POINT_LOOKUPS the organisation table is read once,
 * never once per row.
 *
 * Run: cd server && node --test routes/agents/agentOrgScope.names.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { withOrganizationNames, MAX_ORG_POINT_LOOKUPS } = require('./agentOrgScope.mts');

/** @param {number} n */
const orgs = (n) => Array.from({ length: n }, (_, i) => ({ id: `org${i}`, name: `Organisation ${i}` }));

/** @param {Array<{ id: string, name: string }>} all */
function lookups(all) {
    const calls = { getOrganization: /** @type {string[]} */ ([]), listOrganizations: 0 };
    return {
        calls,
        getOrganization: async (/** @type {string} */ id) => { calls.getOrganization.push(id); return all.find((o) => o.id === id) || null; },
        listOrganizations: async () => { calls.listOrganizations += 1; return all; },
    };
}

test('rows of a few organisations: one read per distinct organisation, none of the table', async () => {
    const all = orgs(50);
    const l = lookups(all);
    const rows = [{ organization_id: 'org1' }, { organization_id: 'org1' }, { organization_id: 'org2' }, { organization_id: null }];
    const named = await withOrganizationNames(rows, l);
    assert.deepStrictEqual(named.map((r) => r.organizationName), ['Organisation 1', 'Organisation 1', 'Organisation 2', null]);
    assert.deepStrictEqual(l.calls.getOrganization.sort(), ['org1', 'org2']);
    assert.strictEqual(l.calls.listOrganizations, 0);
});

test('rows of many organisations: the table once, no reads by id', async () => {
    const all = orgs(MAX_ORG_POINT_LOOKUPS + 5);
    const l = lookups(all);
    const rows = all.flatMap((o) => [{ organization_id: o.id }, { organization_id: o.id }]);
    const named = await withOrganizationNames(rows, l);
    assert.strictEqual(named[0].organizationName, 'Organisation 0');
    assert.strictEqual(l.calls.listOrganizations, 1);
    assert.deepStrictEqual(l.calls.getOrganization, []);
});

test('no row with an organisation: nothing is read', async () => {
    const l = lookups(orgs(3));
    const named = await withOrganizationNames([{ organization_id: null }, { organization_id: '' }], l);
    assert.deepStrictEqual(named.map((r) => r.organizationId), [null, null]);
    assert.strictEqual(l.calls.listOrganizations, 0);
    assert.deepStrictEqual(l.calls.getOrganization, []);
});

test('a failed read leaves the names null and is reported', async () => {
    /** @type {unknown[]} */
    const heard = [];
    const failing = { getOrganization: async () => { throw new Error('down'); }, listOrganizations: async () => [] };
    const named = await withOrganizationNames([{ organization_id: 'org1' }], failing, (e) => heard.push(e));
    assert.strictEqual(named[0].organizationId, 'org1');
    assert.strictEqual(named[0].organizationName, null);
    assert.strictEqual(heard.length, 1);
});
