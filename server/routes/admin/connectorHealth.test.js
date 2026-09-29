/**
 * /auth/admin/connector-health — authz + customer-safe /mine tests.
 *
 * Harness modeled on routes/admin/modules.authz.test.js: the router runs over
 * real HTTP (express + ephemeral port) with req.session injected per test;
 * leaf dependencies are stubbed via require.cache (orgHealthStore in-memory,
 * userStore fixtures, usageStore counts, permissions/gateMeta pass-throughs)
 * so no pg pool is ever opened.
 *
 * Verifies:
 *   - 401 unauthenticated on all four endpoints
 *   - fleet: org_admin 403, super-admin 200 passthrough {generatedAt,orgs,orphans}
 *   - :orgId gates: org_admin of another org 403, own org 200, plain member
 *     403, super-admin 200; events limit is capped at 100
 *   - /mine: operator message/remediation NEVER reaches the customer — soft
 *     wording per code, meta stripped to the {reason} whitelist (dropped for
 *     billing codes), chat.dlp_blocked hidden, non-admin 403, no-org 404
 *   - toCustomerSafeProblem pure transform (fallback wording for unknown codes)
 *
 * Run: node --test server/routes/admin/connectorHealth.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Module = require('module');

process.env.NODE_ENV = 'test';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

// ── auth stubs ─────────────────────────────────────────────────────────────
//
// The org rows the real permissions module would read from the DB. They live
// here, NOT on the session: an SSO session's user object carries only the
// identity profile (id, email, names, picture, provider). Modelling org
// membership on the session is what let a 403-for-every-SSO-org-admin bug ship
// while these tests stayed green, so the fixtures below deliberately mirror
// production and the gates resolve through these rows instead.
const USER_ROWS = {
    admin1: { id: 'admin1', role: 'admin', orgRole: '', organizationId: '' },
    oa1: { id: 'oa1', role: 'user', orgRole: 'org_admin', organizationId: 'org-a' },
    ob1: { id: 'ob1', role: 'user', orgRole: 'org_admin', organizationId: 'org-b' },
    um1: { id: 'um1', role: 'user', orgRole: 'member', organizationId: 'org-a' },
};
const isPlatform = (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin');

mock('../../auth/permissions', {
    requireAuth: (req, res, next) => {
        if (!req.session || !req.session.isAuthenticated || !req.session.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        next();
    },
    // Mirrors the real gate. The router used to declare a private copy of this
    // function; it now imports the shared one, so the stub has to provide it.
    requireSuperAdmin: (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        if (isPlatform(req)) return next();
        return res.status(403).json({ error: 'Operator access required' });
    },
    isOrgAdminForOrg: async (req, orgId) => {
        if (isPlatform(req)) return true;
        const u = USER_ROWS[req.session?.user?.id];
        return !!u && u.organizationId === orgId
            && (u.orgRole === 'org_admin' || u.orgRole === 'admin');
    },
    resolveUserOrgIds: async (req) => {
        if (isPlatform(req)) return null; // no org filter
        const u = USER_ROWS[req.session?.user?.id];
        return new Set(u?.organizationId ? [u.organizationId] : []);
    },
});
mock('../../auth/gateMeta', { tagGate: (fn) => fn });

// ── orgHealthStore stub (records call args; canned data) ───────────────────
const storeCalls = { listProblems: [], listEvents: [], computeHealth: [] };
const FLEET = {
    generatedAt: '2026-07-23T10:00:00.000Z',
    orgs: [{ id: 'org-a', name: 'Org A', health: 'ok', problems: [] }],
    orphans: [{ subjectKey: 'nc:inst-9', lastSeenAt: null, problems: [] }],
};
// Operator-facing rows exactly as the store returns them (camelCase).
let problemRows = [];
const EVENTS_PAGE = { events: [{ id: 'ev1', code: 'bootstrap.org_created', severity: 'info', createdAt: '2026-07-20T00:00:00Z' }], nextCursor: 'CUR2' };
mock('../../stores/orgHealthStore', {
    getFleetOverview: async () => FLEET,
    listProblems: async (opts) => { storeCalls.listProblems.push(opts); return problemRows; },
    listEvents: async (opts) => { storeCalls.listEvents.push(opts); return EVENTS_PAGE; },
    computeHealth: (org) => {
        storeCalls.computeHealth.push(org);
        if (org.hasActiveSubscription === false) return 'no_subscription';
        return 'ok';
    },
});

// ── userStore / usageStore stubs ────────────────────────────────────────────
const ORGS = {
    'org-a': { id: 'org-a', name: 'Org A', nc_instance_id: 'inst-a', nc_onboarding_completed_at: null },
    'org-b': { id: 'org-b', name: 'Org B', nc_instance_id: null, nc_onboarding_completed_at: '2026-07-01T00:00:00Z' },
};
let orgSubscription = null; // per-test
mock('../../stores/userStore', {
    getOrganization: async (id) => ORGS[id] || null,
    getAllUsers: async () => [
        { id: 'u1', organizationId: 'org-a', status: 'active' },
        { id: 'u2', organizationId: 'org-a', status: 'pending' },
        { id: 'u3', organizationId: 'org-a', status: 'pending' },
        { id: 'u4', organizationId: 'org-b', status: 'active' },
    ],
    getOrgSubscription: async () => orgSubscription,
});
mock('../../stores/usageStore', {
    getUsageSummary: async () => ({ total_calls: 0 }),
});

const express = require('express');
const routerModule = require('./connectorHealth');
const { toCustomerSafeProblem, DEFAULT_SAFE } = routerModule;

let server, baseUrl;
let session = null;

before(async () => {
    const app = express();
    app.use((req, res, next) => { req.session = session; next(); });
    app.use('/auth', routerModule);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

async function get(path) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
}

// Shaped like a real SSO session: identity only. No orgRole, no
// organizationId, no permissions — those are resolved from USER_ROWS above,
// exactly as the production gates resolve them from the database.
const SUPER_ADMIN = { isAuthenticated: true, isAdmin: true, user: { id: 'admin1', role: 'admin' } };
const ORG_A_ADMIN = { isAuthenticated: true, isAdmin: false, user: { id: 'oa1', email: 'oa1@example.com' } };
const ORG_B_ADMIN = { isAuthenticated: true, isAdmin: false, user: { id: 'ob1', email: 'ob1@example.com' } };
const ORG_A_MEMBER = { isAuthenticated: true, isAdmin: false, user: { id: 'um1', email: 'um1@example.com' } };

test('401 unauthenticated on all endpoints', async () => {
    session = null;
    assert.strictEqual((await get('/auth/admin/connector-health/fleet')).status, 401);
    assert.strictEqual((await get('/auth/admin/connector-health/mine')).status, 401);
    assert.strictEqual((await get('/auth/admin/connector-health/org-a/problems')).status, 401);
    assert.strictEqual((await get('/auth/admin/connector-health/org-a/events')).status, 401);
});

test('fleet: org_admin 403, super-admin 200 passthrough', async () => {
    session = ORG_A_ADMIN;
    assert.strictEqual((await get('/auth/admin/connector-health/fleet')).status, 403);
    session = SUPER_ADMIN;
    const { status, body } = await get('/auth/admin/connector-health/fleet');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.generatedAt, FLEET.generatedAt);
    assert.ok(Array.isArray(body.orgs) && body.orgs[0].id === 'org-a');
    assert.ok(Array.isArray(body.orphans) && body.orphans[0].subjectKey === 'nc:inst-9');
});

test('problems: cross-org 403, own org 200, member 403, super-admin 200', async () => {
    problemRows = [{ code: 'chat.subscription_blocked', category: 'chat', severity: 'critical', message: 'op msg', remediation: 'op fix', meta: {}, count: 3 }];
    session = ORG_B_ADMIN;
    assert.strictEqual((await get('/auth/admin/connector-health/org-a/problems')).status, 403);
    session = ORG_A_MEMBER;
    assert.strictEqual((await get('/auth/admin/connector-health/org-a/problems')).status, 403);
    session = ORG_A_ADMIN;
    const own = await get('/auth/admin/connector-health/org-a/problems');
    assert.strictEqual(own.status, 200);
    assert.strictEqual(own.body.problems.length, 1);
    // Operator endpoints keep the stored operator wording (unlike /mine).
    assert.strictEqual(own.body.problems[0].message, 'op msg');
    session = SUPER_ADMIN;
    assert.strictEqual((await get('/auth/admin/connector-health/org-a/problems')).status, 200);
    // includeResolved flag is forwarded to the store
    await get('/auth/admin/connector-health/org-a/problems?includeResolved=1');
    const last = storeCalls.listProblems[storeCalls.listProblems.length - 1];
    assert.strictEqual(last.includeResolved, true);
});

test('problems: unknown org 404', async () => {
    session = SUPER_ADMIN;
    assert.strictEqual((await get('/auth/admin/connector-health/nope/problems')).status, 404);
});

test('events: passthrough {events,nextCursor}; limit capped at 100', async () => {
    session = ORG_A_ADMIN;
    const { status, body } = await get('/auth/admin/connector-health/org-a/events?limit=500&severity=error&code=chat.provider_error&cursor=CUR1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, EVENTS_PAGE);
    const call = storeCalls.listEvents[storeCalls.listEvents.length - 1];
    assert.strictEqual(call.limit, 100, 'limit must be capped at 100');
    assert.strictEqual(call.severity, 'error');
    assert.strictEqual(call.code, 'chat.provider_error');
    assert.strictEqual(call.cursor, 'CUR1');
    assert.strictEqual(call.organizationId, 'org-a');
});

test('mine: member 403; org_admin gets customer-safe wording, no operator internals', async () => {
    problemRows = [
        {
            code: 'chat.subscription_blocked', category: 'chat', severity: 'critical',
            message: 'AI requests are blocked because the organization has no active subscription.',
            remediation: 'Assign a subscription to this organization, or configure the NC-recommended default plan.',
            meta: { reason: 'no_subscription' }, count: 42,
            firstSeenAt: '2026-07-01T00:00:00Z', lastSeenAt: '2026-07-23T00:00:00Z',
        },
        {
            code: 'auth.blocked_onboarding_pending', category: 'auth', severity: 'warning',
            message: 'op msg', remediation: 'op fix', meta: { reason: 'wizard_not_completed' }, count: 5,
        },
        { code: 'chat.dlp_blocked', category: 'chat', severity: 'info', message: 'x', remediation: 'y', meta: {}, count: 1 },
    ];
    orgSubscription = null; // no subscription row → hasActiveSubscription false

    session = ORG_A_MEMBER;
    assert.strictEqual((await get('/auth/admin/connector-health/mine')).status, 403);

    session = ORG_A_ADMIN;
    const { status, body } = await get('/auth/admin/connector-health/mine');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.health, 'no_subscription');
    assert.deepStrictEqual(body.users, { total: 3, active: 1, pending: 2 });

    // dlp_blocked hidden from customers
    assert.strictEqual(body.problems.length, 2);
    const sub = body.problems.find(p => p.code === 'chat.subscription_blocked');
    assert.strictEqual(sub.message, 'AI chat is not available for your organisation yet.');
    assert.strictEqual(sub.remediation, 'A configuration step is needed — contact your Bee Flow contact person.');
    // billing-sensitive code → meta dropped wholesale (reason was billing state)
    assert.deepStrictEqual(sub.meta, {});
    const onboarding = body.problems.find(p => p.code === 'auth.blocked_onboarding_pending');
    assert.strictEqual(onboarding.message, 'Nextcloud setup has not been completed yet.');
    assert.strictEqual(onboarding.remediation, 'Complete the setup wizard from your Nextcloud admin account.');
    // non-billing code → meta.reason whitelist survives
    assert.deepStrictEqual(onboarding.meta, { reason: 'wizard_not_completed' });

    // No operator wording anywhere in the payload (billing internals).
    const raw = JSON.stringify(body).toLowerCase();
    assert.ok(!raw.includes('subscription plan'), 'no plan internals');
    assert.ok(!raw.includes('nc-recommended'), 'no operator remediation');
    assert.ok(!raw.includes('op msg') && !raw.includes('op fix'), 'no stored operator text');
});

test('mine: super-admin without an organization → 404, never 500', async () => {
    session = SUPER_ADMIN; // role admin, no organizationId
    const { status } = await get('/auth/admin/connector-health/mine');
    assert.strictEqual(status, 404);
});

test('toCustomerSafeProblem: unknown code falls back to soft default wording', () => {
    const out = toCustomerSafeProblem({
        code: 'auth.some_future_code', category: 'auth', severity: 'error',
        message: 'internal operator text', remediation: 'check the API keys',
        meta: { reason: 'because', apiKeyHint: 'leak' }, count: 2,
    });
    assert.strictEqual(out.message, DEFAULT_SAFE.message);
    assert.strictEqual(out.remediation, DEFAULT_SAFE.remediation);
    assert.deepStrictEqual(out.meta, { reason: 'because' }, 'only the reason whitelist survives');
    assert.strictEqual(out.count, 2);
});

test('toCustomerSafeProblem: hides chat.dlp_blocked entirely', () => {
    assert.strictEqual(toCustomerSafeProblem({ code: 'chat.dlp_blocked', severity: 'info' }), null);
});
