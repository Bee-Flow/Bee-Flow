/**
 * C-01 — cross-tenant takeover via the user-update route.
 *
 * THE FINDING. A self-registered user is org_admin of the tenant their signup
 * created. They send one request against their OWN account:
 *
 *     PUT /auth/users/<self>  {"organizationId":"bee-flow"}
 *
 * and land inside someone else's tenant, still carrying org_admin — from where
 * GET /auth/users and GET /auth/organizations disclose that tenant's members,
 * e-mail addresses, roles, auth method and integrations.
 *
 * WHY THE GATE PASSED. requireOrgAdminForUser resolved the target org from the
 * stored row — the org being LEFT — and asked "may I manage this user?". For a
 * self-targeted request the answer is honestly yes. The destination was never
 * examined. Note the asymmetry it lived next to: POST /users has always checked
 * req.body.organizationId, because on create there is no row to read instead.
 *
 * THE SECOND KEY. isOrgAdminForOrg treats membership of any group as membership
 * of that group's org, so an unvalidated `groups` array reaches another tenant
 * without touching organizationId at all. Group ids are slugified names and
 * globally unique, so they are guessable rather than secret.
 *
 * These tests assert the PROPERTY — a user cannot end up in a tenant they do not
 * administer by any request they can author — not the status code of one route.
 * The final test drives the read path afterwards, so a future change that
 * reintroduces the write somewhere else still fails here.
 *
 * Harness follows adminRoutes.selfDemote.test.js.
 *
 * Run: cd server && node --test auth/adminRoutes.crossTenant.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    users: [],
    groups: [],
    orgs: [],
    roles: [],
    updates: [],
    created: [],
};

const mw = (req, res, next) => next();

class SeatCapExceededError extends Error { }

/**
 * The real org resolver, not a stub: every read assertion below is only worth
 * something if the row's organizationId is what actually scopes the response.
 * Mirrors permissions.js — direct membership plus group-derived orgs, and null
 * (meaning "unscoped") for a super admin.
 */
async function resolveUserOrgIds(req) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return null;
    const me = fx.users.find((u) => u.id === req.session?.user?.id);
    if (!me) return new Set();
    const ids = new Set();
    if (me.organizationId) ids.add(me.organizationId);
    for (const gid of me.groups || []) {
        const g = fx.groups.find((x) => x.id === gid);
        if (g?.organizationId) ids.add(g.organizationId);
    }
    return ids;
}

// Keys are the require strings AS WRITTEN inside auth/admin/* — the modules
// adminRoutes.js now mounts (see the parent-filename filter below).
const MOCKS = {
    '../../stores/userStore': {
        getAllUsers: async () => fx.users.map((u) => ({ ...u })),
        getAllGroups: async () => fx.groups.map((g) => ({ ...g })),
        getAllRoles: async () => fx.roles.map((r) => ({ ...r })),
        getAllOrganizations: async () => fx.orgs.map((o) => ({ ...o })),
        getUser: async (id) => {
            const u = fx.users.find((x) => x.id === id);
            return u ? { ...u } : null;
        },
        updateUser: async (id, updates) => {
            fx.updates.push([id, updates]);
            // Apply, so the read-path test sees what the write actually did.
            const u = fx.users.find((x) => x.id === id);
            if (!u) return false;
            for (const [k, v] of Object.entries(updates)) {
                if (v !== undefined) u[k] = v;
            }
            return true;
        },
        deleteUser: async () => true,
        createUserWithSeatCheck: async (user) => {
            fx.created.push(user);
            return { created: true };
        },
        logAccessAudit: async () => { },
        SeatCapExceededError,
    },
    '../permissions': {
        loadConfig: async () => ({ admin: { username: 'admin' } }),
        saveConfig: async () => { },
        requireAuth: mw,
        requireAdmin: mw,
        requireSuperAdmin: mw,
        requirePermission: () => mw,
        requireOrgAdmin: () => mw,
        requirePrimaryOrgAdmin: () => mw,
        requireActiveOrg: mw,
        requireActiveOrgForMutations: () => mw,
        getUserPermissions: async () => ['all'],
        hasPermission: async () => true,
        isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
        resolveUserOrgIds,
        SYSTEM_PERMISSIONS: [],
        OrgRoles: { ORG_ADMIN: 'org_admin' },
        isOrgAdminRole: (r) => r === 'org_admin' || r === 'admin',
        invalidatePermissionCache: () => { },
        invalidateAllPermissionCaches: () => { },
        invalidateUserExistenceCache: () => { },
    },
    '../encryption': {
        rewrapUserDEKCompat: async () => ({ success: true, encryptionKey: 'session-dek' }),
        adminResetUser: async () => { },
        getOrCreateUserDEKCompat: async () => null,
    },
    '../passwordPolicy': {
        validatePassword: () => ({ ok: true }),
        MIN_PASSWORD_LENGTH: 8,
        MIN_ADMIN_PASSWORD_LENGTH: 12,
    },
    '../../core/entitlements/limits': { checkResourceLimits: async () => null },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => mw },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:adminroutes-crosstenant:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/](admin[\\/][^\\/]+|adminRoutes)\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

let router;
let loadError = null;
try {
    router = require('./adminRoutes');
} catch (err) {
    loadError = err;
}
Module._resolveFilename = originalResolve;

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const request = {
            method,
            url,
            body,
            query: {},
            params: {},
            headers: {},
            session: { save: (cb) => cb && cb(null), ...session },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

// ── Fixtures ─────────────────────────────────────────────────────────
// `kv` reproduces the attacker: sole member and sole admin of the throwaway org
// their own signup created. That shape matters — with no other members, the
// sole-org-admin guard has nobody to strand and cannot mask the result. It is
// why the pentest's move succeeded where a populated org would have 409'd.
function resetFx() {
    fx.orgs = [
        { id: 'orgA', name: 'Acme B.V.' },
        { id: 'orgB', name: 'Beta N.V.' },
        { id: 'orgprobe', name: 'OrgProbe' },
    ];
    fx.groups = [
        { id: 'g_fin', name: 'Finance', organizationId: 'orgA' },
        { id: 'g_beta', name: 'Beta team', organizationId: 'orgB' },
        { id: 'g_global', name: 'Everyone', organizationId: null },
    ];
    // The seeded roles, plus one a super admin has created that carries `all` —
    // the shape that turns `users.role` from an inert label into a real grant.
    fx.roles = [
        { id: 'admin', permissions: ['all'] },
        { id: 'user', permissions: ['read', 'chat'] },
        { id: 'org_admin', permissions: ['org.manage'] },
        { id: 'admin_light', permissions: ['all'] },
    ];
    fx.users = [
        { id: 'jan', username: 'jan', displayName: 'Jan', email: 'jan@acme.nl', organizationId: 'orgA', groups: ['g_fin'], orgRole: 'org_admin', status: 'active' },
        { id: 'eva', username: 'eva', displayName: 'Eva', email: 'eva@acme.nl', organizationId: 'orgA', groups: ['g_fin'], orgRole: 'member', status: 'active' },
        { id: 'bob', username: 'bob', displayName: 'Bob', email: 'bob@beta.nl', organizationId: 'orgB', groups: ['g_beta'], orgRole: 'org_admin', status: 'active' },
        { id: 'kv', username: 'kv', displayName: 'KV', email: 'kv@probe.test', organizationId: 'orgprobe', groups: [], orgRole: 'org_admin', status: 'active' },
    ];
    fx.updates.length = 0;
    fx.created.length = 0;
}

const user = (id) => fx.users.find((u) => u.id === id);
const SUPER = { isAuthenticated: true, isAdmin: true, user: { id: 'root', role: 'admin' } };
const JAN = { isAuthenticated: true, user: { id: 'jan' } };
const EVA = { isAuthenticated: true, user: { id: 'eva' } };
const KV = { isAuthenticated: true, user: { id: 'kv' } };

test('the router loaded with its dependencies stubbed', () => {
    assert.strictEqual(loadError, null, loadError && loadError.message);
    assert.strictEqual(typeof router, 'function');
});

// ═══ The reported exploit ════════════════════════════════════════════

test('C-01: an org admin cannot move THEMSELVES into another tenant', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/kv', session: KV,
        body: { organizationId: 'orgA' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'cross_org_move_denied');
    assert.deepStrictEqual(fx.updates, [], 'nothing may reach the store');
    assert.strictEqual(user('kv').organizationId, 'orgprobe');
});

test('C-01: the exploit verbatim — sole admin of a throwaway org, org_admin carried along', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/kv', session: KV,
        body: { organizationId: 'orgA', orgRole: 'org_admin' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(user('kv').organizationId, 'orgprobe');
    assert.deepStrictEqual(fx.updates, []);
});

test('C-01: nor can they move someone else out of their own tenant', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN,
        body: { organizationId: 'orgB' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'cross_org_move_denied');
    assert.strictEqual(user('eva').organizationId, 'orgA');
});

test('C-01: clearing the organisation is a move too', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN,
        body: { organizationId: '' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'cross_org_move_denied');
});

// ═══ The same hole via `groups` ══════════════════════════════════════

test('C-01b: an org admin cannot assign a group belonging to another tenant', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/kv', session: KV,
        body: { groups: ['g_fin'] },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'cross_org_group_denied');
    assert.deepStrictEqual(res.body.groups, ['g_fin']);
    assert.deepStrictEqual(fx.updates, []);
});

test('C-01b: a group that does not exist is refused, not silently dropped', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN,
        body: { groups: ['g_fin', 'g_does_not_exist'] },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body.groups, ['g_does_not_exist']);
});

test('C-01b: groups in the caller\'s own org, and global groups, are still assignable', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN,
        body: { groups: ['g_fin', 'g_global'] },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(user('eva').groups, ['g_fin', 'g_global']);
});

test('C-01b: create is guarded the same way', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/users', session: JAN,
        body: { username: 'new', displayName: 'New', password: 'CorrectHorse!42', organizationId: 'orgA', groups: ['g_beta'] },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'cross_org_group_denied');
    assert.deepStrictEqual(fx.created, []);
});

// ═══ What must keep working ══════════════════════════════════════════

test('the users panel PUTs the whole row back — an unchanged organizationId is fine', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN,
        body: {
            id: 'eva', username: 'eva', displayName: 'Eva Bakker', email: 'eva@acme.nl',
            organizationId: 'orgA', orgRole: 'member', groups: ['g_fin'], role: 'user', status: 'active',
        },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(user('eva').displayName, 'Eva Bakker');
    assert.strictEqual(user('eva').organizationId, 'orgA', 'unchanged, and never written by a non-super caller');
    const [, written] = fx.updates.at(-1);
    assert.ok(!('organizationId' in written) || written.organizationId === undefined,
        'a non-super caller must not write the tenant key even when echoing it back');
});

test('whitespace around an unchanged organisation id is not a move', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN,
        body: { organizationId: ' orgA ', displayName: 'Eva B' },
    });
    assert.strictEqual(res.statusCode, 200, 'the ids are equal once normalised');
    assert.strictEqual(user('eva').displayName, 'Eva B');
    assert.strictEqual(user('eva').organizationId, 'orgA', 'and the padded value is never stored');
});

test('a user with no organisation is still unmanageable by an org admin (pre-existing)', async () => {
    resetFx();
    user('eva').organizationId = null;
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN,
        body: { displayName: 'Eva B' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /without an organisation/);
});

test('a super admin may still move a user between tenants', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/kv', session: SUPER,
        body: { organizationId: 'orgB' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(user('kv').organizationId, 'orgB');
});

test('a moved user does not carry org_admin into the destination', async () => {
    resetFx();
    await dispatch({
        method: 'PUT', url: '/users/kv', session: SUPER,
        body: { organizationId: 'orgB' },
    });
    assert.strictEqual(user('kv').orgRole, 'member',
        'org_admin of the org they left says nothing about the one they joined');
});

test('an explicit orgRole in the same request still wins', async () => {
    resetFx();
    await dispatch({
        method: 'PUT', url: '/users/kv', session: SUPER,
        body: { organizationId: 'orgB', orgRole: 'org_admin' },
    });
    assert.strictEqual(user('kv').orgRole, 'org_admin');
});

test('a super admin still cannot strand a populated organisation', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/jan', session: SUPER,
        body: { organizationId: 'orgB' },
    });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'last_org_admin');
    assert.strictEqual(user('jan').organizationId, 'orgA');
});

test('a plain member still cannot promote themselves', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: EVA,
        body: { orgRole: 'org_admin' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(user('eva').orgRole, 'member');
});

test('creating a user in another tenant was already refused — pinned', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/users', session: JAN,
        body: { username: 'mole', displayName: 'Mole', password: 'CorrectHorse!42', organizationId: 'orgB' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.created, []);
});

// ═══ M-01 — the platform `role` field ════════════════════════════════
//
// The guard here was a denylist of ONE exact string. `{"role":"admin"}` was
// refused; `super_admin`, `root`, `Admin`, `" admin"` were accepted and stored.
// A pentest called that harmless because authorization reads `isAdmin` and
// `orgRole` — true of the values it tried, false in general: permissions.js
// resolves `users.role` as a KEY into the roles table and unions in whatever
// that row grants, so a role carrying `all` short-circuits getUserPermissions
// to ['all'] and clears every requirePermission gate in the product.

test('M-01: the literal admin role is still refused, with its own message', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN, body: { role: 'admin' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /super admin/i);
});

test('M-01: a value that misses the roles table is refused, not stored', async () => {
    resetFx();
    for (const role of ['super_admin', 'superadmin', 'root', 'system', 'Admin', 'ADMIN', ' admin', 'admin ']) {
        const res = await dispatch({
            method: 'PUT', url: '/users/eva', session: JAN, body: { role },
        });
        assert.ok(res.statusCode === 400 || res.statusCode === 403,
            `role ${JSON.stringify(role)} must be refused, got ${res.statusCode}`);
        assert.strictEqual(user('eva').role, undefined, 'and nothing may be written');
    }
});

test('M-01: an org admin cannot assign a custom role that carries `all`', async () => {
    resetFx();
    // admin_light is a real, resolvable role — so the allow-list accepts the
    // VALUE. What refuses it is that changing the platform role at all is an
    // operator action. This is the live escalation the report judged latent.
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN, body: { role: 'admin_light' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'role_change_denied');
    assert.deepStrictEqual(fx.updates, []);
});

test('M-01: nor can they promote themselves that way', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/users/jan', session: JAN, body: { role: 'admin_light' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'role_change_denied');
});

test('M-01: nor smuggle one in through create', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/users', session: JAN,
        body: { username: 'mole', displayName: 'Mole', password: 'CorrectHorse!42', organizationId: 'orgA', role: 'admin_light' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.created, []);
});

test('M-01: the panel echoing the stored role back is not a change', async () => {
    resetFx();
    user('eva').role = 'user';
    const res = await dispatch({
        method: 'PUT', url: '/users/eva', session: JAN,
        body: { role: 'user', displayName: 'Eva B' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(user('eva').displayName, 'Eva B');
});

test('M-01: a super admin may set a real role, but still not an invented one', async () => {
    resetFx();
    const ok = await dispatch({
        method: 'PUT', url: '/users/eva', session: SUPER, body: { role: 'admin_light' },
    });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(user('eva').role, 'admin_light');

    const bad = await dispatch({
        method: 'PUT', url: '/users/eva', session: SUPER, body: { role: 'super_admin' },
    });
    assert.strictEqual(bad.statusCode, 400);
    assert.strictEqual(bad.body.code, 'unknown_role');
    assert.strictEqual(user('eva').role, 'admin_light', 'the good value must survive the bad one');
});

// ═══ The outcome, not the status code ════════════════════════════════

test('after the refused move, the attacker still sees only their own tenant', async () => {
    resetFx();
    await dispatch({ method: 'PUT', url: '/users/kv', session: KV, body: { organizationId: 'orgA' } });
    await dispatch({ method: 'PUT', url: '/users/kv', session: KV, body: { groups: ['g_fin'] } });

    const users = await dispatch({ method: 'GET', url: '/users', session: KV });
    assert.strictEqual(users.statusCode, 200);
    const ids = (users.body.users || users.body).map((u) => u.id);
    assert.ok(!ids.includes('jan'), 'orgA members must not be visible');
    assert.ok(!ids.includes('eva'), 'orgA members must not be visible');
    assert.ok(ids.includes('kv'), 'the caller always sees themselves');

    const orgs = await dispatch({ method: 'GET', url: '/organizations', session: KV });
    const orgIds = (orgs.body.organizations || orgs.body).map((o) => o.id);
    assert.deepStrictEqual(orgIds, ['orgprobe'], 'and only their own organisation');
});
