// @typecheck
/**
 * GET /agents/all and the admin dashboard's organisation (`?orgId`,
 * routes/agents/agentOrgScope.mts, decided by auth/adminOrg.mts):
 *
 *   - a platform admin sees every organisation without `?orgId`, one
 *     organisation with it, and a 404 for an organisation that does not exist;
 *   - an organisation admin of A who is also in a group of B keeps the list
 *     they had (A and B); naming their home organisation changes nothing, and
 *     naming B is a 403;
 *   - a caller with manage_agents who is no organisation admin and names no
 *     organisation sees no new refusal;
 *   - every row names its organisation (null for an agent without one), read
 *     once per distinct organisation of the rows; a failed read leaves the
 *     names null and the list served.
 *
 * No module mocking: the gates are opened by testUtils/routeHarness, the
 * stores are swapped on their module objects (testUtils/swaps); the
 * organisation decision (resolveAdminOrgId, _evalOrgAdmin) is the real one.
 *
 * Run: cd server && node --test routes/agents/published.orgScope.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const fx = require('./orgScope.testkit');

const { db, api, agentStore, userStore, swaps } = fx.boot(() => require('./published'));

const AGENTS = [
    { id: 'a1', name: 'Agent A', organization_id: 'orgA', owner_id: 'someone', config: {} },
    { id: 'b1', name: 'Agent B', organization_id: 'orgB', owner_id: 'someone', config: {} },
    { id: 'n1', name: 'Agent without organisation', organization_id: null, owner_id: 'someone', config: {} },
];

test.before(async () => {
    await db.settle();
    fx.swapUserStore(swaps, userStore);
    swaps.swap(agentStore, 'getAllAgents', async () => AGENTS.map((a) => ({ ...a })));
    swaps.swap(agentStore, 'getAgentChatStats', async () => new Map());
});
test.beforeEach(() => fx.resetCounters());
test.after(async () => {
    swaps.restore();
    await api.close();
});

/**
 * @param {string} who
 * @param {string} [query]
 */
function list(who, query = '') {
    return api.call('GET', `/agents/all${query}`, { user: fx.USERS[who] });
}

/** @param {{ body: any }} res */
const ids = (res) => res.body.map((/** @type {{ id: string }} */ a) => a.id).sort();

test('a platform admin without orgId sees every organisation, each row named', async () => {
    const res = await list('plat');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(ids(res), ['a1', 'b1', 'n1']);
    const byId = Object.fromEntries(res.body.map((/** @type {any} */ a) => [a.id, a]));
    assert.strictEqual(byId.a1.organizationId, 'orgA');
    assert.strictEqual(byId.a1.organizationName, 'Organisation A');
    assert.strictEqual(byId.b1.organizationName, 'Organisation B');
    assert.strictEqual(byId.n1.organizationId, null);
    assert.strictEqual(byId.n1.organizationName, null);
    assert.strictEqual(fx.counters.getOrganization, 2, 'one read per organisation of the rows, not per row');
    assert.strictEqual(fx.counters.listOrganizations, 0, 'the organisation table is not read for two organisations');
});

test('a platform admin with orgId sees that organisation only', async () => {
    const res = await list('plat', '?orgId=orgB');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(ids(res), ['b1']);
    assert.strictEqual(res.body[0].organizationName, 'Organisation B');
});

test('a platform admin naming an organisation that does not exist gets a 404', async () => {
    const res = await list('plat', '?orgId=orgZ');
    assert.strictEqual(res.status, 404, res.text);
    assert.strictEqual(res.body.code, 'organization_not_found');
});

test('a repeated orgId is refused, not guessed', async () => {
    const res = await list('plat', '?orgId=orgA&orgId=orgB');
    assert.strictEqual(res.status, 400, res.text);
});

test('an organisation admin of A in a group of B keeps the list they had', async () => {
    const res = await list('annA');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(ids(res), ['a1', 'b1']);
    const named = await list('annA', '?orgId=orgA');
    assert.strictEqual(named.status, 200, named.text);
    assert.deepStrictEqual(ids(named), ['a1', 'b1']);
});

test('an organisation admin of A naming organisation B is refused', async () => {
    const res = await list('annA', '?orgId=orgB');
    assert.strictEqual(res.status, 403, res.text);
    assert.strictEqual(res.body.code, 'org_admin_required');
});

test('a caller who is no organisation admin and names nothing sees no new refusal', async () => {
    const res = await list('memberA');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(ids(res), ['a1']);
    assert.strictEqual(res.body[0].organizationName, 'Organisation A');
});

test('a failed organisation read leaves the names null and serves the list', async () => {
    fx.failOrganizations(true);
    try {
        const res = await list('plat');
        assert.strictEqual(res.status, 200, res.text);
        assert.deepStrictEqual(ids(res), ['a1', 'b1', 'n1']);
        for (const row of res.body) assert.strictEqual(row.organizationName, null);
        assert.strictEqual(res.body.find((/** @type {any} */ a) => a.id === 'a1').organizationId, 'orgA');
    } finally {
        fx.failOrganizations(false);
    }
});
