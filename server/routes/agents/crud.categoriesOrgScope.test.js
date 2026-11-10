// @typecheck
/**
 * GET /agents/categories and the admin dashboard's organisation (`?orgId`,
 * routes/agents/agentOrgScope.mts, decided by auth/adminOrg.mts):
 *
 *   - a platform admin lists every category without `?orgId`, the categories
 *     of one organisation with it, and gets a 404 for an organisation that
 *     does not exist;
 *   - an organisation admin of A who is also in a group of B keeps the list
 *     they had (the first of their organisations); naming B is a 403;
 *   - every row names its organisation (null for a category without one).
 *
 * No module mocking: gates opened by testUtils/routeHarness, stores swapped
 * on their module objects; resolveAdminOrgId and _evalOrgAdmin are real.
 *
 * Run: cd server && node --test routes/agents/crud.categoriesOrgScope.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const h = require('../../testUtils/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');
const fx = require('./orgScope.testkit');

const db = h.recordDb();
h.openGates({ resolveUserOrgIds: fx.resolveUserOrgIds });
const agentStore = require('../../stores/agentStore');
const userStore = require('../../stores/userStore');
const api = h.serve('/agents', require('./crud'));
const swaps = makeSwaps();

const CATEGORIES = [
    { id: 'catA', organization_id: 'orgA', name: 'Sales' },
    { id: 'catB', organization_id: 'orgB', name: 'Support' },
    { id: 'catNone', organization_id: null, name: 'General' },
];
/** @type {Array<string | null | undefined>} */
const asked = [];

/** @type {Array<string | null | undefined>} */
const created = [];

test.before(async () => {
    await db.settle();
    fx.swapUserStore(swaps, userStore);
    swaps.swap(agentStore, 'getAgentCategories', async (/** @type {string | null | undefined} */ orgId) => {
        asked.push(orgId);
        return CATEGORIES.filter((c) => !orgId || c.organization_id === orgId).map((c) => ({ ...c }));
    });
    swaps.swap(agentStore, 'findAgentCategoryByName', async () => null);
    swaps.swap(agentStore, 'createAgentCategory', async (/** @type {string | null} */ orgId, /** @type {string} */ name) => {
        created.push(orgId);
        return { id: 'catNew', organization_id: orgId, name };
    });
});
test.beforeEach(() => { asked.length = 0; created.length = 0; fx.resetCounters(); });
test.after(async () => {
    swaps.restore();
    await api.close();
});

/**
 * @param {string} who
 * @param {string} [query]
 */
function list(who, query = '') {
    return api.call('GET', `/agents/categories${query}`, { user: fx.USERS[who] });
}

/** @param {{ body: any }} res */
const ids = (res) => res.body.map((/** @type {{ id: string }} */ c) => c.id).sort();

test('a platform admin without orgId lists every category, each row named', async () => {
    const res = await list('plat');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(asked, [null]);
    assert.deepStrictEqual(ids(res), ['catA', 'catB', 'catNone']);
    const byId = Object.fromEntries(res.body.map((/** @type {any} */ c) => [c.id, c]));
    assert.strictEqual(byId.catA.organizationName, 'Organisation A');
    assert.strictEqual(byId.catB.organizationId, 'orgB');
    assert.strictEqual(byId.catB.organizationName, 'Organisation B');
    assert.strictEqual(byId.catNone.organizationId, null);
    assert.strictEqual(byId.catNone.organizationName, null);
    assert.strictEqual(fx.counters.getOrganization, 2, 'one read per organisation of the rows, not per row');
    assert.strictEqual(fx.counters.listOrganizations, 0, 'the organisation table is not read for two organisations');
});

test('a platform admin with orgId lists that organisation only', async () => {
    const res = await list('plat', '?orgId=orgB');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(asked, ['orgB']);
    assert.deepStrictEqual(ids(res), ['catB']);
});

test('a platform admin naming an organisation that does not exist gets a 404', async () => {
    const res = await list('plat', '?orgId=orgZ');
    assert.strictEqual(res.status, 404, res.text);
    assert.strictEqual(res.body.code, 'organization_not_found');
    assert.deepStrictEqual(asked, [], 'nothing is read for a refused organisation');
});

test('an organisation admin of A in a group of B keeps the list they had', async () => {
    const res = await list('annA');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(asked, ['orgA']);
    assert.deepStrictEqual(ids(res), ['catA']);
    const named = await list('annA', '?orgId=orgA');
    assert.strictEqual(named.status, 200, named.text);
    assert.deepStrictEqual(ids(named), ['catA']);
});

test('an organisation admin of A naming organisation B is refused', async () => {
    const res = await list('annA', '?orgId=orgB');
    assert.strictEqual(res.status, 403, res.text);
    assert.strictEqual(res.body.code, 'org_admin_required');
    assert.deepStrictEqual(asked, []);
});

test('a caller who is no organisation admin and names nothing sees no new refusal', async () => {
    const res = await list('memberA');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(ids(res), ['catA']);
});

/**
 * @param {string} who
 * @param {string} [query]
 */
function create(who, query = '') {
    return api.call('POST', `/agents/categories${query}`, { user: fx.USERS[who], body: { name: 'Sales' } });
}

test('a platform admin creates a category in the organisation the list is narrowed to', async () => {
    const res = await create('plat', '?orgId=orgB');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(created, ['orgB']);
    const global = await create('plat');
    assert.strictEqual(global.status, 200, global.text);
    assert.deepStrictEqual(created, ['orgB', null], 'without orgId: a category of no organisation, as before');
});

test('a platform admin naming an organisation that does not exist creates nothing', async () => {
    const res = await create('plat', '?orgId=orgZ');
    assert.strictEqual(res.status, 404, res.text);
    assert.deepStrictEqual(created, []);
});

test('an organisation admin creates in their first organisation, and cannot name another', async () => {
    const res = await create('annA');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(created, ['orgA']);
    const refused = await create('annA', '?orgId=orgB');
    assert.strictEqual(refused.status, 403, refused.text);
    assert.deepStrictEqual(created, ['orgA']);
});
