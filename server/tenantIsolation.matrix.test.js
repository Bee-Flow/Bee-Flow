'use strict';

/**
 * Tenant isolation, END TO END, against a real Postgres: a resource of org B
 * is not readable, writable or deletable by a member of org A.
 *
 * One fixture per resource kind (testUtils/tenantFixtures.js) is created in
 * org B by user B. Every route the fixture lists is then called as user A with
 * B's id and must answer 403 or 404: never 200, never a 500 (a crash is not a
 * refusal). The first route is also called as B and must answer 200, so a kind
 * whose routes refuse everyone cannot pass by accident.
 *
 * The routers are the real ones, served behind their real gates by
 * testUtils/routeHarness.js; the stores are the real ones over
 * @electric-sql/pglite (testUtils/pglitePool.js), so a WHERE that forgets the
 * organisation shows up as a 200 here. The session is the only thing supplied
 * from outside, exactly what express-session would hand the router.
 *
 * The second half is an inventory: every route in auth/routes.contract.json
 * with a path parameter is either covered by a fixture or listed in
 * tenantIsolation.exemptions.json with a reason, and that list only shrinks
 * (lint:tenant-matrix-ratchet). A new route with a `:id` therefore registers
 * its fixture kind or says why it cannot be driven this way.
 *
 * Run: cd server && node --test tenantIsolation.matrix.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'matrix-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'matrix-test-master-key-0123456789abcdef0123456789';

// The real db.js, answered by one PGlite connection; before any store loads.
const { usePglitePool } = require('./testUtils/pglitePool');
const { close: closePg } = usePglitePool();

const h = require('./testUtils/routeHarness');
const { FIXTURES } = require('./testUtils/tenantFixtures');

const ORG_A = 'org-matrix-a';
const ORG_B = 'org-matrix-b';
const USER_A = { id: 'u-matrix-a', username: 'matrix-a', email: 'a@matrix.test', organizationId: ORG_A, role: 'user', orgRole: 'member', groups: [] };
const USER_B = { id: 'u-matrix-b', username: 'matrix-b', email: 'b@matrix.test', organizationId: ORG_B, role: 'user', orgRole: 'member', groups: [] };

/** @type {Map<string, { id: string, api: ReturnType<typeof h.serve> }>} */
const created = new Map();
const servers = [];

before(async () => {
    const userStore = require('./stores/userStore');
    await userStore.initDB();
    // Both orgs on a plan that grants the features their routers gate on
    // (automations, datatables); an org without a plan is refused by the licence
    // gate, which is an entitlement, not an identity, and not what this test is about.
    const plan = await userStore.createPlan({ name: 'Matrix plan', tier: 'pro', allowed_features: ['automations', 'datatables', 'webpages', 'agents', 'knowledge'] });
    for (const [id, name] of [[ORG_A, 'Org A'], [ORG_B, 'Org B']]) {
        await userStore.createOrganization({ id, name }, { autoGrantTrial: false });
        await userStore.setOrgSubscription(id, { plan_id: plan.id, status: 'active' });
    }
    for (const u of [USER_A, USER_B]) await userStore.createUser({ ...u, passwordHash: 'x' });
    // Stores initialise their schema on first use; PGlite is one session, so one at a time.
    for (const store of ['agentStore', 'webpageStore', 'automationStore', 'datatableStore', 'notebookStore']) {
        const s = require(`./stores/${store}`);
        if (typeof s.initDB === 'function') await s.initDB();
    }
    let index = 0;
    for (const f of FIXTURES) {
        const id = await f.create({ orgId: ORG_B, userId: USER_B.id, index: ++index });
        const api = h.serve(f.mount, f.router(), { user: USER_A });
        servers.push(api);
        created.set(f.kind, { id, api });
    }
}, { timeout: 120_000 });

after(async () => {
    for (const s of servers) await s.close();
    await closePg();
});

const fill = (route, id) => route.replace(/:[A-Za-z_]+/g, id);

for (const f of FIXTURES) {
    test(`${f.kind}: the owner in org B reads their own resource`, async () => {
        const { id, api } = created.get(f.kind);
        const [method, route] = f.routes[0].split(' ');
        const res = await api.call(method, fill(route, id), { user: USER_B });
        assert.equal(res.status, f.ownerStatus || 200, `${f.routes[0]} as the owner: ${res.status} ${res.text.slice(0, 200)}`);
    });

    test(`${f.kind}: a member of org A cannot reach it by id`, async () => {
        const { id, api } = created.get(f.kind);
        const leaks = [];
        for (const r of f.routes) {
            const [method, route] = r.split(' ');
            const res = await api.call(method, fill(route, id), { user: USER_A, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
            if (res.status !== 403 && res.status !== 404) leaks.push(`${r} → ${res.status}`);
        }
        assert.deepEqual(leaks, [], `org A reached org B's ${f.kind}:\n  ${leaks.join('\n  ')}`);
    });
}

// ── The inventory half ──────────────────────────────────────────────────────

const contract = require('./auth/routes.contract.json');
const exemptions = require('./tenantIsolation.exemptions.json');

const PARAM = /:[A-Za-z_]+/;
const paramRoutes = Object.keys(contract.routes).filter((id) => PARAM.test(id.split(' ')[1]));
const covered = new Set(FIXTURES.flatMap((f) => f.routes));

test('every route with a path parameter is covered by a fixture or exempted with a reason', () => {
    const missing = paramRoutes.filter((id) => !covered.has(id) && !exemptions.routes[id]);
    assert.deepEqual(missing, [],
        `routes with a parameter that no fixture kind drives and no exemption names:\n  ${missing.join('\n  ')}\n` +
        'Add the route to a kind in testUtils/tenantFixtures.js (or add the kind), or list it in tenantIsolation.exemptions.json with the reason it cannot be driven by id.');
});

test('every exemption still names a mounted, uncovered route', () => {
    const stale = Object.keys(exemptions.routes).filter((id) => !contract.routes[id] || covered.has(id));
    assert.deepEqual(stale, [], `exemptions that are gone or now covered by a fixture (remove them): ${stale.join(', ')}`);
    for (const [id, reason] of Object.entries(exemptions.routes)) {
        assert.ok(typeof reason === 'string' && reason.length >= 20, `${id}: the exemption needs a reason`);
    }
});

test('every fixture route exists in the contract, spelled the same way', () => {
    const unknown = [...covered].filter((id) => !contract.routes[id]);
    assert.deepEqual(unknown, [], `fixture routes not in auth/routes.contract.json: ${unknown.join(', ')}`);
});

test('synthetic: the id fills every parameter of a route', () => {
    assert.equal(fill('GET /api/x/:id/rows/:rowId', 'abc'), 'GET /api/x/abc/rows/abc');
    assert.equal(path.posix.join('/a', 'b'), '/a/b');
});
