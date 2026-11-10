/**
 * Who may rewrite the chat model tiers (routes/ai/config/modelTiers.js).
 *
 * `chat_model_tiers` and `chat_model_tiers_eu` are instance-wide: every chat,
 * agent and automation on the install resolves "tier:fast", "tier:thinking" … to
 * the model named there, and the EU set is what an org with "EU only" switched
 * on is routed to. Every other write in this file checked isAdminUser; these
 * two only checked requireAuth, so any signed-in member could point the whole
 * install at a model of their choosing — including, for the EU set, one that
 * does not process in the EU. Found by validation batch 2a, outside its
 * territory.
 *
 * The reads stay open on purpose: the tier pickers every member sees read them.
 *
 * The organisation's OWN custom tiers (/config/org-custom-chat-models) are
 * state of one organisation: the caller must be an admin of the organisation
 * the request targets, by the strict check (auth/permissionsOrgGates
 * _evalOrgAdmin, the real function, fed fixture users and groups here), or a
 * platform admin. Verified in both deployment modes.
 *
 * Run: cd server && node --test routes/ai/config/modelTiers.authz.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// The real barrel, for the real super-admin predicate and the strict
// org-admin decision; modelTiers itself gets the double below. Required at
// call time: loading it first would load this router before the doubles are
// in place. By its absolute path: Node caches a relative request per
// directory, and this file shares its directory with the router, whose
// '../../../auth/permissions' must stay the double. The barrel loads
// userStore, so a recording pool keeps it off Postgres.
const { recordDb } = require('../../../testUtils/routeHarness');
const db = recordDb();
const REAL_PERMISSIONS = require('path').resolve(__dirname, '../../../auth/permissions.js');
const realPermissions = () => require(REAL_PERMISSIONS);

const writes = [];
const fx = {
    admin: false,
    /** @type {Record<string, object>} */
    users: {},
    /** @type {object[]} */
    groups: [],
};

const MOCKS = {
    '../../../stores/configStore': {
        getConfig: async () => null,
        setConfig: async (key, value) => { writes.push([key, value]); },
    },
    '../../../stores/userStore': {
        getUser: async (id) => fx.users[id] || null,
        getAllGroups: async () => fx.groups,
    },
    './shared': { isAdminUser: async () => fx.admin },
    '../../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Not authenticated' })),
        // isOrgAdminForOrg exactly, with the two store reads answered by the fixture.
        isOrgAdminForOrg: async (req, orgId) => realPermissions().isSuperAdmin(req)
            || realPermissions()._evalOrgAdmin(fx.users[req.session?.user?.id], fx.groups, orgId),
    },
    '../../../core/aiAgent': { getProviderForModel: async () => ({ providerType: 'claude', url: '' }) },
    '../../../core/llm/promptClassifier': { clearClassifierCache: () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:model-tiers-authz:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /config[\\/]modelTiers\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./modelTiers');
test.before(async () => { realPermissions(); await db.settle(); });
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method, url, body = {}, query = {}, session = { user: { id: 'member-1' } } }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body, headers: {}, session, query, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
    });
}

const TIERS = { fast: { modelId: 'attacker-model', label: 'Fast' } };

test.beforeEach(() => { writes.length = 0; fx.admin = false; });

for (const url of ['/config/chat-models', '/config/chat-models-eu']) {
    test(`POST ${url} by a member who is not an admin is refused, and nothing is written`, async () => {
        const res = await dispatch({ method: 'POST', url, body: TIERS });
        assert.strictEqual(res.statusCode, 403);
        assert.deepStrictEqual(writes, []);
    });

    test(`POST ${url} by an admin still saves`, async () => {
        fx.admin = true;
        const res = await dispatch({ method: 'POST', url, body: TIERS });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(writes.length, 1);
    });

    test(`GET ${url} stays readable for every member — the tier pickers read it`, async () => {
        const res = await dispatch({ method: 'GET', url });
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.body.fast, 'the default tiers come back');
    });
}

// ── The organisation's own custom tiers ─────────────────────────────────────

const ORG_TIERS = '/config/org-custom-chat-models';
const TIER = { id: 'custom:x', label: 'X', modelId: 'm' };
// An org_admin of org-a who is also in a plain group of org-b.
const ADMIN_A = { id: 'admin-a', role: 'user', orgRole: 'org_admin', organizationId: 'org-a', groups: ['g-b'] };
const MEMBER_A = { id: 'member-a', role: 'user', orgRole: 'member', organizationId: 'org-a', groups: [] };
const PLATFORM = { id: 'platform-1', role: 'admin', groups: [] };
const sessionOf = (u) => ({ isAuthenticated: true, user: { id: u.id, role: u.role, organizationId: u.organizationId } });
const keyOf = (orgId) => `custom_chat_model_tiers_org_${orgId}`;

/** Runs `fn` once per deployment mode; nothing in this gate may depend on it. */
async function inEachMode(fn) {
    const before = process.env.DEPLOYMENT_MODE;
    try {
        for (const mode of ['cloud', 'self-hosted']) {
            process.env.DEPLOYMENT_MODE = mode;
            writes.length = 0;
            await fn(mode);
        }
    } finally {
        if (before === undefined) delete process.env.DEPLOYMENT_MODE;
        else process.env.DEPLOYMENT_MODE = before;
    }
}

function orgFixture() {
    fx.users = { [ADMIN_A.id]: ADMIN_A, [MEMBER_A.id]: MEMBER_A, [PLATFORM.id]: PLATFORM };
    fx.groups = [{ id: 'g-b', organizationId: 'org-b', permissions: [], roles: [] }];
}

test('org tiers: an admin of org A is refused for org B (by query or body), and nothing is written', async () => {
    orgFixture();
    await inEachMode(async (mode) => {
        const read = await dispatch({ method: 'GET', url: ORG_TIERS, query: { orgId: 'org-b' }, session: sessionOf(ADMIN_A) });
        assert.strictEqual(read.statusCode, 403, mode);
        assert.deepStrictEqual(read.body, { error: 'Org admin access required' });
        const write = await dispatch({ method: 'POST', url: ORG_TIERS, body: { orgId: 'org-b', tiers: [TIER] }, session: sessionOf(ADMIN_A) });
        assert.strictEqual(write.statusCode, 403, mode);
        assert.deepStrictEqual(writes, [], `${mode}: a refused write reaches no store`);
    });
});

test('org tiers: an admin of org A reads and writes org A, named or implied', async () => {
    orgFixture();
    await inEachMode(async (mode) => {
        const read = await dispatch({ method: 'GET', url: ORG_TIERS, session: sessionOf(ADMIN_A) });
        assert.strictEqual(read.statusCode, 200, `${mode}: ${JSON.stringify(read.body)}`);
        assert.strictEqual(read.body.orgId, 'org-a');
        const named = await dispatch({ method: 'GET', url: ORG_TIERS, query: { orgId: 'org-a' }, session: sessionOf(ADMIN_A) });
        assert.strictEqual(named.statusCode, 200, mode);
        assert.strictEqual(named.body.orgId, 'org-a');
        const write = await dispatch({ method: 'POST', url: ORG_TIERS, body: { orgId: 'org-a', tiers: [TIER] }, session: sessionOf(ADMIN_A) });
        assert.strictEqual(write.statusCode, 200, mode);
        assert.deepStrictEqual(writes.map(([k]) => k), [keyOf('org-a')]);
    });
});

test('org tiers: a member who is not an org admin is refused for their own organisation', async () => {
    orgFixture();
    await inEachMode(async (mode) => {
        const read = await dispatch({ method: 'GET', url: ORG_TIERS, session: sessionOf(MEMBER_A) });
        assert.strictEqual(read.statusCode, 403, mode);
        const write = await dispatch({ method: 'POST', url: ORG_TIERS, body: { tiers: [TIER] }, session: sessionOf(MEMBER_A) });
        assert.strictEqual(write.statusCode, 403, mode);
        assert.deepStrictEqual(writes, []);
    });
});

test('org tiers: a platform admin may name any organisation; without one and without an org it is a 400', async () => {
    orgFixture();
    fx.admin = true;
    await inEachMode(async (mode) => {
        const write = await dispatch({ method: 'POST', url: ORG_TIERS, body: { orgId: 'org-b', tiers: [TIER] }, session: sessionOf(PLATFORM) });
        assert.strictEqual(write.statusCode, 200, mode);
        assert.deepStrictEqual(writes.map(([k]) => k), [keyOf('org-b')]);
        const none = await dispatch({ method: 'GET', url: ORG_TIERS, session: sessionOf(PLATFORM) });
        assert.strictEqual(none.statusCode, 400, mode);
    });
});
