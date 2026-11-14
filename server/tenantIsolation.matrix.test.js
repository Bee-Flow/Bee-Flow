'use strict';

/**
 * Tenant isolation, END TO END, against a real Postgres: a resource of org B
 * is not readable, writable or deletable by a member of org A.
 *
 * One fixture per resource kind (testUtils/tenantFixtures.js) is created in
 * org B by user B. Every route the fixture lists is then called as user A with
 * B's id and must answer 403 or 404: never 200, never a 500 (a crash is not a
 * refusal). The first route is also called as B and must answer 200, so a kind
 * whose routes refuse everyone cannot pass by accident. A kind gated on
 * org-admin (`orgAdminCaller`) is also called as the organisation admin of org A
 * who is a plain member of a group of org B: a member of B, not its admin, so
 * the same 403 or 404.
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
// The second caller shape, for kinds with `orgAdminCaller`: the organisation
// admin of org A who is also a plain member of a group of org B. Belonging to
// org B is not administering it.
const GROUP_B_PLAIN = 'g-matrix-b-plain';
const ADMIN_A = { id: 'u-matrix-a-admin', username: 'matrix-a-admin', email: 'a-admin@matrix.test', organizationId: ORG_A, role: 'user', orgRole: 'org_admin', groups: [GROUP_B_PLAIN] };
// The same caller under the names the agent and knowledge-base cases use.
const USER_AB = ADMIN_A;
/** Kinds without the orgAdminCaller flag whose every route this caller is refused too (the fixture is a draft of org B). */
const ADMIN_ELSEWHERE = new Set(['agent', 'knowledgeBase']);
// An organisation admin of B: the management rights of B hold for them.
const USER_B_ADMIN = { id: 'u-matrix-b-admin', username: 'matrix-b-admin', email: 'b-admin@matrix.test', organizationId: ORG_B, role: 'user', orgRole: 'org_admin', groups: [] };
/** A PUBLISHED base of org B shared with the whole organisation: every member of B, USER_AB included, may read it. */
let publishedKbB = '';

/** @type {Map<string, { id: string, api: ReturnType<typeof h.serve> }>} */
const created = new Map();
const servers = [];

before(async () => {
    const userStore = require('./stores/userStore');
    await userStore.initDB();
    // Both orgs on a plan that grants the features their routers gate on
    // (automations, datatables); an org without a plan is refused by the licence
    // gate, which is an entitlement, not an identity, and not what this test is about.
    const plan = await userStore.createPlan({ name: 'Matrix plan', tier: 'pro', allowed_features: ['automations', 'datatables', 'webpages', 'agents', 'knowledge', 'notebooks'] });
    for (const [id, name] of [[ORG_A, 'Org A'], [ORG_B, 'Org B']]) {
        await userStore.createOrganization({ id, name }, { autoGrantTrial: false });
        await userStore.setOrgSubscription(id, { plan_id: plan.id, status: 'active' });
    }
    await userStore.createGroup({ id: GROUP_B_PLAIN, organizationId: ORG_B, name: 'Org B plain group', permissions: [], roles: [] });
    for (const u of [USER_A, USER_B, ADMIN_A, USER_B_ADMIN]) await userStore.createUser({ ...u, passwordHash: 'x' });
    // Stores initialise their schema on first use; PGlite is one session, so one at a time.
    for (const store of ['agentStore', 'webpageStore', 'automationStore', 'datatableStore', 'notebookStore', 'studioAppStore']) {
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
    const kbStore = require('./stores/knowledgeBases');
    const kb = await kbStore.createKB(USER_B.id, 'Published KB of org B', 'matrix fixture', ORG_B, {});
    await kbStore.setPublished(kb.id, true, []);
    publishedKbB = kb.id;
}, { timeout: 120_000 });

after(async () => {
    for (const s of servers) await s.close();
    await closePg();
});

/** Every parameter is the id, except the ones the kind fixes (`params`). */
const fill = (route, id, params = {}) => route.replace(/:([A-Za-z_]+)/g, (_m, name) => params[name] ?? id);
/** The address of one of the kind's routes: its parameters filled, and the query string the kind gives it (`queries`). */
const urlOf = (f, r, id) => fill(r.split(' ')[1], id, f.params) + (f.queries?.[r] ? `?${f.queries[r]}` : '');

for (const f of FIXTURES) {
    test(`${f.kind}: the owner in org B reads their own resource`, async () => {
        const { id, api } = created.get(f.kind);
        const [method] = f.routes[0].split(' ');
        // The same body the callers send, so a route that validates first answers the owner past its schema.
        const res = await api.call(method, urlOf(f, f.routes[0], id), { user: USER_B, body: f.bodies?.[f.routes[0]] });
        assert.equal(res.status, f.ownerStatus || 200, `${f.routes[0]} as the owner: ${res.status} ${res.text.slice(0, 200)}`);
    });

    const callers = [['a member of org A', USER_A]];
    if (f.orgAdminCaller || ADMIN_ELSEWHERE.has(f.kind)) callers.push(['an admin of org A who is a plain group member of org B', ADMIN_A]);
    for (const [who, caller] of callers) {
        test(`${f.kind}: ${who} cannot reach it by id`, async () => {
            const { id, api } = created.get(f.kind);
            const leaks = [];
            for (const r of f.routes) {
                const [method] = r.split(' ');
                const body = f.bodies?.[r] ?? (method === 'GET' || method === 'DELETE' ? undefined : {});
                const res = await api.call(method, urlOf(f, r, id), { user: caller, body });
                if (res.status !== 403 && res.status !== 404) leaks.push(`${r} → ${res.status}`);
            }
            assert.deepEqual(leaks, [], `${who} reached org B's ${f.kind}:\n  ${leaks.join('\n  ')}`);
        });
    }
}

// ── A management right holds in the organisation it was granted in ─────────
// USER_AB holds manage_knowledge and manage_agents in org A only. Org B is in
// their organisation union (a plain group), so they READ B's published base;
// they do not change its content, and they create nothing in B.

const NO_DOC = '00000000-0000-4000-8000-000000000000';
/** The routes that change a base's content, each with a body its schema accepts. */
const CONTENT_WRITES = [
    ['POST', '/ingest/text', { content: 'Text that must not land here.', title: 'Matrix' }],
    ['POST', '/ingest/url', { url: 'https://example.com/' }],
    ['POST', '/ingest/file', undefined],
    ['POST', '/ingest/n8n', { workflowId: 'wf-matrix' }],
    ['POST', '/ingest/sitemap', { url: 'https://example.com/' }],
    ['POST', '/documents/bulk-delete', { documentIds: [NO_DOC] }],
    ['DELETE', `/documents/${NO_DOC}`, undefined],
    ['POST', '/reindex', {}],
];

test('knowledgeBase: an admin of org A who is a plain group member of org B reads B\'s published base but cannot change its content', async () => {
    const { api } = created.get('knowledgeBase');
    const read = await api.call('GET', `/api/kb/${publishedKbB}`, { user: USER_AB });
    assert.equal(read.status, 200, `the published base is readable for a member of org B: ${read.status} ${read.text.slice(0, 200)}`);
    const leaks = [];
    for (const [method, suffix, body] of CONTENT_WRITES) {
        const res = await api.call(method, `/api/kb/${publishedKbB}${suffix}`, { user: USER_AB, body });
        if (res.status !== 403) leaks.push(`${method} ${suffix} → ${res.status} ${res.text.slice(0, 120)}`);
    }
    assert.deepEqual(leaks, [], `a right held in org A changed org B's base:\n  ${leaks.join('\n  ')}`);
});

test('knowledgeBase: an admin of org B changes the content of B\'s base', async () => {
    const { api } = created.get('knowledgeBase');
    const res = await api.call('POST', `/api/kb/${publishedKbB}/reindex`, { user: USER_B_ADMIN, body: {} });
    assert.equal(res.status, 200, `${res.status} ${res.text.slice(0, 200)}`);
});

test('kbCategory: a category of org B is deleted by an admin of B, not by an admin of A who holds manage_knowledge in A only', async () => {
    const { api } = created.get('kbCategory');
    const kbStore = require('./stores/knowledgeBases');
    // Its own category: the kind's fixture is gone once the owner's case above deleted it.
    const { id } = await kbStore.createKBCategory({ id: 'cat-matrix-admin', organizationId: ORG_B, name: 'Category of B', icon: null, color: null });
    const foreign = await api.call('DELETE', `/api/kb/categories/${id}`, { user: USER_AB });
    assert.equal(foreign.status, 404, `${foreign.status} ${foreign.text.slice(0, 200)}`);
    assert.ok((await kbStore.listKBCategories(ORG_B)).some((c) => c.id === id), 'the category of org B is still there');
    const own = await api.call('DELETE', `/api/kb/categories/${id}`, { user: USER_B_ADMIN });
    assert.equal(own.status, 200, `${own.status} ${own.text.slice(0, 200)}`);
    assert.ok(!(await kbStore.listKBCategories(ORG_B)).some((c) => c.id === id));
});

test('knowledgeBase: a base is created only in an organisation where manage_knowledge holds', async () => {
    const { api } = created.get('knowledgeBase');
    const inB = await api.call('POST', '/api/kb', { user: USER_AB, body: { name: 'Matrix KB in B', organizationId: ORG_B } });
    assert.equal(inB.status, 403, `${inB.status} ${inB.text.slice(0, 200)}`);
    const inA = await api.call('POST', '/api/kb', { user: USER_AB, body: { name: 'Matrix KB in A', organizationId: ORG_A } });
    assert.equal(inA.status, 201, `${inA.status} ${inA.text.slice(0, 200)}`);
    assert.equal(inA.body.organization_id, ORG_A);
    // A copy of B's base is a personal copy, not a base of org B.
    const copy = await api.call('POST', `/api/kb/${publishedKbB}/duplicate`, { user: USER_AB });
    assert.equal(copy.status, 201, `${copy.status} ${copy.text.slice(0, 200)}`);
    assert.equal(copy.body.organization_id, null);
    assert.equal(copy.body.tenant_id, USER_AB.id);
});

test('agent: an agent is created only in an organisation where manage_agents holds', async () => {
    const { api } = created.get('agent');
    const inB = await api.call('POST', '/agents', { user: USER_AB, body: { name: 'Matrix agent in B', organizationId: ORG_B } });
    assert.equal(inB.status, 403, `${inB.status} ${inB.text.slice(0, 200)}`);
    const inA = await api.call('POST', '/agents', { user: USER_AB, body: { name: 'Matrix agent in A', organizationId: ORG_A } });
    assert.equal(inA.status, 200, `${inA.status} ${inA.text.slice(0, 200)}`);
    assert.equal(inA.body.organization_id, ORG_A);
});

// ── The support desk of org B is not listed for a right held in org A ───────
// support_inbox and the admin role hold per organisation: the inbox list of
// USER_AB (admin of A, a plain group member of B) leaves out B's inboxes.

test('supportInbox: the inbox list of an admin of org A who is a plain group member of org B leaves out B\'s inboxes', async () => {
    const { id, api } = created.get('supportInbox');
    const own = await api.call('GET', '/api/support-inbox/inboxes', { user: USER_B });
    assert.ok(own.body.inboxes.some((i) => i.id === id), `the owner lists their inbox: ${own.text.slice(0, 200)}`);
    const res = await api.call('GET', '/api/support-inbox/inboxes', { user: USER_AB });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.deepEqual(res.body.inboxes.filter((i) => i.organization_id === ORG_B).map((i) => i.id), []);
});

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
    assert.equal(fill('GET /api/x/:id/versions/:ref', 'abc', { ref: 'current' }), 'GET /api/x/abc/versions/current');
    assert.equal(path.posix.join('/a', 'b'), '/a/b');
});
