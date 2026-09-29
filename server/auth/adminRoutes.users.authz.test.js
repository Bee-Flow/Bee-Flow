/**
 * Authorization + response-shape tests for GET /auth/users.
 *
 * Two things are pinned here:
 *
 * 1. THE GATE. The route declares only `requireAuth` and decides the real gate
 *    inside the handler (adminRoutes.js:119-129), so nothing about it is visible
 *    to a route-table walk. These tests are the only executable record of it.
 *    Org scoping is part of the gate, not cosmetics: an org-admin must see their
 *    own org's members and nobody else's.
 *
 * 2. THE LEAK REGRESSION. userStore.getAllUsers() used to SELECT
 *    "masterWrappedDEK", "wrappedDEK", "kekSalt", "recoverySalt" and
 *    "recoveryWrappedDEK", and this route does a bare res.json() over the result
 *    — so every holder of org_admin / admin_security / manage_users received
 *    every visible user's wrapped DEKs and KDF salts: the full input set for an
 *    offline password attack, no server needed. On a zero-knowledge product that
 *    is not acceptable in a user list. The final test fails if any of those
 *    fields ever reappear in the response.
 *
 * Run: cd server && node --test auth/adminRoutes.users.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');


// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    users: [],
    groups: [],
    orgs: [],
    perms: [],       // what getUserPermissions returns for a non-super caller
    sqlSeen: [],
};

// The crypto material that must never reach a client through this route.
const KEY_FIELDS = ['masterWrappedDEK', 'wrappedDEK', 'kekSalt', 'recoverySalt', 'recoveryWrappedDEK'];

const mw = (req, res, next) => next();

// Keys are the require strings AS WRITTEN inside auth/admin/* — the modules
// adminRoutes.js now mounts (see the parent-filename filter below).
const MOCKS = {
    '../../stores/userStore': {
        getAllUsers: async () => {
            fx.sqlSeen.push('getAllUsers');
            return fx.users.map((u) => ({ ...u }));
        },
        getAllGroups: async () => fx.groups.map((g) => ({ ...g })),
        getAllOrganizations: async () => fx.orgs.map((o) => ({ ...o })),
        getUser: async (id) => fx.users.find((u) => u.id === id) || null,
    },
    '../permissions': {
        loadConfig: async () => ({ admin: { username: 'admin' } }),
        saveConfig: async () => {},
        requireAuth: mw,
        requireAdmin: mw,
        // Real behaviour, not a pass-through: this file's subject is who may
        // read the user/org lists, and role mutation is now operator-only, so a
        // pass-through here would make those routes look reachable to anyone.
        requireSuperAdmin: (req, res, next) => {
            if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
            if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
            return res.status(403).json({ error: 'Operator access required' });
        },
        requirePermission: () => mw,
        requireOrgAdmin: () => mw,
        requirePrimaryOrgAdmin: () => mw,
        requireActiveOrg: mw,
        requireActiveOrgForMutations: () => mw,
        getUserPermissions: async () => fx.perms,
        hasPermission: async (_id, perm) => fx.perms.includes(perm) || fx.perms.includes('all'),
        isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
        resolveUserOrgIds: async (req) => {
            if (req.session?.isAdmin || req.session?.user?.role === 'admin') return null;
            const me = fx.users.find((x) => x.id === req.session?.user?.id);
            const out = new Set();
            if (me?.organizationId) out.add(me.organizationId);
            for (const gid of me?.groups || []) {
                const g = fx.groups.find((x) => x.id === gid);
                if (g?.organizationId) out.add(g.organizationId);
            }
            return out;
        },
        SYSTEM_PERMISSIONS: [],
        OrgRoles: { ORG_ADMIN: 'org_admin' },
        isOrgAdminRole: (r) => r === 'org_admin' || r === 'admin',
        invalidatePermissionCache: () => {},
        invalidateAllPermissionCaches: () => {},
    },
    '../encryption': {
        rewrapUserDEKCompat: async () => {},
        adminResetUser: async () => {},
        getOrCreateUserDEKCompat: async () => null,
    },
    '../../core/entitlements/limits': { checkResourceLimits: async () => null },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => mw },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:adminroutes-users:${request}`;
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
            session,
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
const withKeys = (u) => ({
    ...u,
    // Simulate the pre-fix store: if the projection regresses, these ride along.
    masterWrappedDEK: 'mwd-secret',
    wrappedDEK: 'wd-secret',
    kekSalt: 'kek-salt',
    recoverySalt: 'rec-salt',
    recoveryWrappedDEK: 'rwd-secret',
});

function resetFx() {
    fx.orgs = [
        { id: 'orgA', name: 'Acme B.V.' },
        { id: 'orgB', name: 'Beta N.V.' },
    ];
    fx.groups = [
        { id: 'g_fin', name: 'Finance', organizationId: 'orgA' },
        { id: 'g_beta', name: 'Beta team', organizationId: 'orgB' },
    ];
    fx.users = [
        { id: 'jan', username: 'jan', displayName: 'Jan', organizationId: 'orgA', groups: ['g_fin'], orgRole: 'org_admin' },
        { id: 'eva', username: 'eva', displayName: 'Eva', organizationId: null, groups: ['g_fin'], orgRole: 'member' },
        { id: 'bob', username: 'bob', displayName: 'Bob', organizationId: 'orgB', groups: ['g_beta'], orgRole: 'member' },
    ];
    fx.perms = [];
    fx.sqlSeen.length = 0;
}

const SUPER = { isAuthenticated: true, isAdmin: true, user: { id: 'root', role: 'admin' } };
const JAN = { isAuthenticated: true, user: { id: 'jan' } };
const BOB = { isAuthenticated: true, user: { id: 'bob' } };

const names = (body) => body.filter((u) => !u.isSystem).map((u) => u.id).sort();

test('the router loaded with its dependencies stubbed', () => {
    assert.strictEqual(loadError, null, loadError && loadError.message);
    assert.strictEqual(typeof router, 'function');
});

// ═══ The gate ═══════════════════════════════════════════════════════

test('a caller with no relevant permission is denied', async () => {
    resetFx();
    fx.perms = ['page_chat'];
    const res = await dispatch({ method: 'GET', url: '/users', session: JAN });
    assert.strictEqual(res.statusCode, 403);
});

for (const perm of ['manage_users', 'admin_security', 'org_admin', 'all']) {
    test(`'${perm}' is enough to view users`, async () => {
        resetFx();
        fx.perms = [perm];
        const res = await dispatch({ method: 'GET', url: '/users', session: JAN });
        assert.strictEqual(res.statusCode, 200);
    });
}

test('a super-admin sees every user', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/users', session: SUPER });
    assert.strictEqual(res.statusCode, 200);
    assert.deepEqual(names(res.body), ['bob', 'eva', 'jan']);
});

test('an org-admin sees their own org only — including transitive members', async () => {
    resetFx();
    fx.perms = ['org_admin'];
    const res = await dispatch({ method: 'GET', url: '/users', session: JAN });
    assert.strictEqual(res.statusCode, 200);
    // eva has NO organizationId — she is in orgA only through g_fin, and must
    // still appear. bob is in orgB and must not.
    assert.deepEqual(names(res.body), ['eva', 'jan']);
});

test('an org-scoped caller never sees another org', async () => {
    resetFx();
    fx.perms = ['org_admin'];
    const res = await dispatch({ method: 'GET', url: '/users', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.deepEqual(names(res.body), ['bob']);
});

test('the caller always sees their own row', async () => {
    resetFx();
    fx.perms = ['manage_users'];
    fx.users.push({ id: 'orphan', username: 'orphan', displayName: 'Orphan', organizationId: '', groups: [] });
    const res = await dispatch({ method: 'GET', url: '/users', session: { isAuthenticated: true, user: { id: 'orphan' } } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepEqual(names(res.body), ['orphan']);
});

// ═══ The leak regression ════════════════════════════════════════════

test('the response carries no envelope-encryption material — super-admin', async () => {
    resetFx();
    fx.users = fx.users.map(withKeys);
    const res = await dispatch({ method: 'GET', url: '/users', session: SUPER });
    assert.strictEqual(res.statusCode, 200);

    const serialised = JSON.stringify(res.body);
    for (const field of KEY_FIELDS) {
        assert.ok(!serialised.includes(field), `GET /auth/users must not expose ${field}`);
    }
    for (const secret of ['mwd-secret', 'wd-secret', 'kek-salt', 'rec-salt', 'rwd-secret']) {
        assert.ok(!serialised.includes(secret), `GET /auth/users leaked the value ${secret}`);
    }
});

test('the response carries no envelope-encryption material — org admin', async () => {
    resetFx();
    fx.perms = ['org_admin'];
    fx.users = fx.users.map(withKeys);
    const res = await dispatch({ method: 'GET', url: '/users', session: JAN });
    assert.strictEqual(res.statusCode, 200);

    const serialised = JSON.stringify(res.body);
    for (const field of KEY_FIELDS) {
        assert.ok(!serialised.includes(field), `an org admin must not receive ${field} for their members`);
    }
});

// ═══ GET /auth/organizations ════════════════════════════════════════
// Same in-handler gate shape as GET /auth/users (adminRoutes.js:577-597). It is
// declared `handler` in auth/accessRegistry.js with a verifiedBy pointing here,
// and the drift test asserts that this file exists — so the declaration is not
// merely believed.

test('organizations: a caller with no relevant permission is denied', async () => {
    resetFx();
    fx.perms = ['page_chat'];
    const res = await dispatch({ method: 'GET', url: '/organizations', session: JAN });
    assert.strictEqual(res.statusCode, 403);
});

for (const perm of ['manage_users', 'admin_security', 'org_admin', 'all']) {
    test(`organizations: '${perm}' is enough to view them`, async () => {
        resetFx();
        fx.perms = [perm];
        const res = await dispatch({ method: 'GET', url: '/organizations', session: JAN });
        assert.strictEqual(res.statusCode, 200);
    });
}

test('organizations: a super-admin sees every org', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/organizations', session: SUPER });
    assert.strictEqual(res.statusCode, 200);
    assert.deepEqual(res.body.map((o) => o.id).sort(), ['orgA', 'orgB']);
});

test('organizations: an org-scoped caller sees only their own org', async () => {
    resetFx();
    fx.perms = ['org_admin'];
    const res = await dispatch({ method: 'GET', url: '/organizations', session: JAN });
    assert.strictEqual(res.statusCode, 200);
    assert.deepEqual(res.body.map((o) => o.id), ['orgA']);
});

test('the fields a client legitimately needs still arrive', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/users', session: SUPER });
    const jan = res.body.find((u) => u.id === 'jan');
    assert.ok(jan, 'jan is in the response');
    for (const field of ['username', 'displayName', 'organizationId', 'groups', 'orgRole']) {
        assert.ok(field in jan, `${field} is still returned`);
    }
});
