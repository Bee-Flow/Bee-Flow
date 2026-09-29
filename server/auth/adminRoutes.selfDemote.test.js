/**
 * Pentest regressions for the user-mutation routes in adminRoutes.js.
 *
 * Three findings are pinned here, all reachable from the same handful of routes:
 *
 * 1. THE ORPHANED TENANT (L-02). PUT /auth/users/<self> with
 *    {"orgRole":"owner"} returned 200 and stripped the organisation's only
 *    administrator of user management permanently — 'owner' is not a role this
 *    product defines, so it resolved to no permissions at all, and every route
 *    that could restore org_admin is itself gated on org_admin. There is no
 *    in-app way back from that; the fix has to refuse the write. Demote, move
 *    to another org, suspend, delete and leave-org are all the same hole, so
 *    they are all tested here.
 *
 * 2. SUCCESS FOR A CHANGE THAT DID NOT HAPPEN (L-04). PUT with
 *    {"isAdmin":true} answered 200 {"success":true} and dropped the field. The
 *    allow-list must now name what it refuses — while still accepting the whole
 *    user row the admin panel PUTs back (it includes `id` and `username`, which
 *    the route ignores on purpose).
 *
 * 3. THE FOUR-CHARACTER PASSWORD (M-01). /change-password enforced a length of
 *    4, and the admin create/update paths enforced nothing, so both were weaker
 *    than signup. All three now run the shared validatePassword().
 *
 * Style follows adminRoutes.users.authz.test.js: the stores and permissions
 * module are stubbed through a Module._resolveFilename hook scoped to
 * adminRoutes.js, and the router is driven with a fake req/res.
 *
 * Run: cd server && node --test auth/adminRoutes.selfDemote.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const bcrypt = require('bcryptjs');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    users: [],
    groups: [],
    orgs: [],
    updates: [],      // [userId, updates] per updateUser call
    deleted: [],
    created: [],
    pwChecks: [],     // every validatePassword() context the routes passed
};

const mw = (req, res, next) => next();

// A deliberately small stand-in for the shared policy module (which another
// change owns). It only has to behave like the contract: length floors, a
// common-password list, and rejection of username/e-mail-derived passwords.
function fakeValidatePassword(password, { username, email, isAdmin } = {}) {
    fx.pwChecks.push({ password, username, email, isAdmin });
    const min = isAdmin ? 12 : 8;
    if (typeof password !== 'string' || password.length < min) {
        return { ok: false, error: `Password must be at least ${min} characters`, code: 'too_short' };
    }
    if (['12345678', 'password', 'qwertyuiop12'].includes(password.toLowerCase())) {
        return { ok: false, error: 'This password is too common', code: 'common_password' };
    }
    const local = String(email || '').split('@')[0];
    for (const derived of [username, local]) {
        if (derived && password.toLowerCase().includes(String(derived).toLowerCase())) {
            return { ok: false, error: 'Password must not contain your name or e-mail', code: 'derived_from_identity' };
        }
    }
    return { ok: true };
}

class SeatCapExceededError extends Error { }

// Keys are the require strings AS WRITTEN inside auth/admin/* — the modules
// adminRoutes.js now mounts (see the parent-filename filter below).
const MOCKS = {
    '../../stores/userStore': {
        getAllUsers: async () => fx.users.map((u) => ({ ...u })),
        getAllGroups: async () => fx.groups.map((g) => ({ ...g })),
        getAllOrganizations: async () => fx.orgs.map((o) => ({ ...o })),
        getUser: async (id) => {
            const u = fx.users.find((x) => x.id === id);
            return u ? { ...u } : null;
        },
        updateUser: async (id, updates) => {
            fx.updates.push([id, updates]);
            return !!fx.users.find((x) => x.id === id);
        },
        deleteUser: async (id) => {
            fx.deleted.push(id);
            return !!fx.users.find((x) => x.id === id);
        },
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
        resolveUserOrgIds: async () => null,
        SYSTEM_PERMISSIONS: [],
        OrgRoles: { ORG_ADMIN: 'org_admin' },
        // Real behaviour — the sole-admin count is built on this predicate, so a
        // pass-through stub would make every test vacuously green.
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
        validatePassword: fakeValidatePassword,
        MIN_PASSWORD_LENGTH: 8,
        MIN_ADMIN_PASSWORD_LENGTH: 12,
    },
    '../../core/entitlements/limits': { checkResourceLimits: () => null },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => mw },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:adminroutes-selfdemote:${request}`;
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
// jan is orgA's ONLY administrator — the situation the pentest orphaned.
const OLD_PASSWORD = 'OldSecret!2468';
const OLD_HASH = bcrypt.hashSync(OLD_PASSWORD, 4);

function resetFx() {
    fx.orgs = [{ id: 'orgA', name: 'Acme B.V.' }, { id: 'orgB', name: 'Beta N.V.' }];
    fx.groups = [
        { id: 'g_fin', name: 'Finance', organizationId: 'orgA' },
        { id: 'g_beta', name: 'Beta team', organizationId: 'orgB' },
    ];
    fx.users = [
        { id: 'jan', username: 'jan', displayName: 'Jan', email: 'jan@acme.nl', organizationId: 'orgA', groups: ['g_fin'], orgRole: 'org_admin', status: 'active', passwordHash: OLD_HASH },
        { id: 'eva', username: 'eva', displayName: 'Eva', email: 'eva@acme.nl', organizationId: 'orgA', groups: ['g_fin'], orgRole: 'member', status: 'active', passwordHash: OLD_HASH },
        { id: 'bob', username: 'bob', displayName: 'Bob', email: 'bob@beta.nl', organizationId: 'orgB', groups: ['g_beta'], orgRole: 'org_admin', status: 'active' },
    ];
    fx.updates.length = 0;
    fx.deleted.length = 0;
    fx.created.length = 0;
    fx.pwChecks.length = 0;
}

const user = (id) => fx.users.find((u) => u.id === id);
const SUPER = { isAuthenticated: true, isAdmin: true, user: { id: 'root', role: 'admin' } };
const JAN = { isAuthenticated: true, user: { id: 'jan' } };
const EVA = { isAuthenticated: true, user: { id: 'eva' } };

test('the router loaded with its dependencies stubbed', () => {
    assert.strictEqual(loadError, null, loadError && loadError.message);
    assert.strictEqual(typeof router, 'function');
});

// ═══ L-02 — the last org admin may not be removed ════════════════════

test('the sole org admin cannot demote themselves — the exact pentest request', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'owner' }, session: JAN });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'last_org_admin');
    assert.deepEqual(fx.updates, [], 'nothing may be written');
});

test('confirmSelfDemotion does NOT buy a way past the sole-admin guard', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'owner', confirmSelfDemotion: true }, session: JAN });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'last_org_admin');
    assert.deepEqual(fx.updates, []);
});

test('an operator cannot demote the last org admin either', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'member' }, session: SUPER });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'last_org_admin');
});

test('suspending the last org admin is refused — a pending admin cannot sign in', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { status: 'suspended' }, session: SUPER });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'last_org_admin');
});

test('moving the last org admin to another organisation is refused', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { organizationId: 'orgB' }, session: SUPER });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'last_org_admin');
});

test('deleting the last org admin is refused', async () => {
    resetFx();
    const res = await dispatch({ method: 'DELETE', url: '/users/jan', session: SUPER });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'last_org_admin');
    assert.deepEqual(fx.deleted, [], 'the row must survive');
});

// The rule is "an organisation with people in it keeps an administrator", not
// "an org_admin row is immortal". Every self-serve org signup creates exactly
// one user, orgRole org_admin — so a guard keyed on the admin count alone makes
// the single most common account shape on this product permanently undeletable,
// through the only erasure path there is. Nobody is stranded when there is
// nobody left to strand.
test('the sole MEMBER of a one-person org can still be deleted', async () => {
    resetFx();
    fx.users = fx.users.filter((u) => u.id !== 'eva');   // jan is now alone in orgA
    const res = await dispatch({ method: 'DELETE', url: '/users/jan', session: SUPER });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(fx.deleted, ['jan']);
});

// Regression: the post-write repair originally excluded nobody, so after the
// write the demoted founder counted as a member of their own org with no
// administrator — and reverted their own deliberate change with a 409. The
// pre-check said "nobody to strand"; the post-check disagreed with it.
test('the sole founder of a one-person org can demote THEMSELVES', async () => {
    resetFx();
    fx.users = fx.users.filter((u) => u.id !== 'eva');   // jan alone in orgA
    const res = await dispatch({
        method: 'PUT', url: '/users/jan',
        body: { orgRole: 'owner', confirmSelfDemotion: true }, session: JAN,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(fx.updates.map((u) => u[0]), ['jan'], 'written once, not written then reverted');
});

test('the sole member of a one-person org can still be suspended and demoted', async () => {
    resetFx();
    fx.users = fx.users.filter((u) => u.id !== 'eva');
    const suspended = await dispatch({ method: 'PUT', url: '/users/jan', body: { status: 'suspended' }, session: SUPER });
    assert.strictEqual(suspended.statusCode, 200, JSON.stringify(suspended.body));

    resetFx();
    fx.users = fx.users.filter((u) => u.id !== 'eva');
    const demoted = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'member' }, session: SUPER });
    assert.strictEqual(demoted.statusCode, 200, JSON.stringify(demoted.body));
});

// The counter treats a group-transitive admin as cover for an org, so the guard
// has to protect that same org — otherwise the two disagree and orgA is
// orphaned by a request that only ever looked at orgB.
test('an admin who administers another org through a group is guarded for THAT org', async () => {
    resetFx();
    // sam's primary org is orgB, but g_fin belongs to orgA and he is org_admin,
    // so he is orgA's only administrator. jan is demoted out of the way first.
    fx.users = [
        { id: 'sam', username: 'sam', organizationId: 'orgB', groups: ['g_fin'], orgRole: 'org_admin', status: 'active' },
        { id: 'eva', username: 'eva', organizationId: 'orgA', groups: ['g_fin'], orgRole: 'member', status: 'active' },
        { id: 'bob', username: 'bob', organizationId: 'orgB', groups: ['g_beta'], orgRole: 'org_admin', status: 'active' },
    ];
    const res = await dispatch({ method: 'PUT', url: '/users/sam', body: { orgRole: 'member' }, session: SUPER });
    assert.strictEqual(res.statusCode, 409, 'orgA would be left with a member and no administrator');
    assert.strictEqual(res.body.code, 'last_org_admin');
    assert.deepEqual(fx.updates, []);
});

test('a second admin who cannot sign in does not keep the org covered', async () => {
    resetFx();
    // Invited but never activated: orgRole says org_admin, login says no.
    fx.users.push({ id: 'nina', username: 'nina', organizationId: 'orgA', groups: [], orgRole: 'org_admin', status: 'pending' });
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'member' }, session: SUPER });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'last_org_admin');
});

test('an admin in another org does not count as this org\'s cover', async () => {
    resetFx();
    // bob is org_admin — but of orgB.
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'member' }, session: SUPER });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'last_org_admin');
});

test('an admin who belongs to the org only through a group does count', async () => {
    resetFx();
    // No organizationId, but a member of g_fin, which belongs to orgA — the
    // same membership isOrgAdminForOrg() honours when granting the gate.
    fx.users.push({ id: 'sam', username: 'sam', organizationId: '', groups: ['g_fin'], orgRole: 'org_admin', status: 'active' });
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'member' }, session: SUPER });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(fx.updates.length, 1);
});

test('with a second active admin the demotion goes through', async () => {
    resetFx();
    user('eva').orgRole = 'org_admin';
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'member' }, session: SUPER });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.deepEqual(fx.updates[0][1].orgRole, 'member');
});

test('demoting an ordinary member is untouched by the guard', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/eva', body: { orgRole: '' }, session: SUPER });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.updates.length, 1);
});

test('promoting is never blocked', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/eva', body: { orgRole: 'org_admin' }, session: SUPER });
    assert.strictEqual(res.statusCode, 200);
});

test('an org admin keeping their role while editing their profile is not blocked', async () => {
    resetFx();
    // The users panel PUTs the whole row back, orgRole included and unchanged.
    const res = await dispatch({
        method: 'PUT',
        url: '/users/jan',
        body: { id: 'jan', username: 'jan', displayName: 'Jan de Vries', orgRole: 'org_admin', organizationId: 'orgA' },
        session: JAN,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
});

// ═══ L-02 — self-demotion needs an explicit opt-in ═══════════════════

test('self-demotion is refused without confirmSelfDemotion, and says why', async () => {
    resetFx();
    user('eva').orgRole = 'org_admin';
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'owner' }, session: JAN });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'confirm_self_demotion');
    assert.deepEqual(fx.updates, [], 'nothing may be written before the client confirms');
    // The hint keeps the shape the SPA already renders.
    assert.strictEqual(res.body.hint.kind, 'role_downgrade');
    assert.strictEqual(res.body.hint.from, 'org_admin');
    assert.strictEqual(res.body.hint.to, 'owner');
    assert.ok(typeof res.body.hint.message === 'string' && res.body.hint.message.length > 0);
});

test('self-demotion goes through once confirmed, and still returns the hint', async () => {
    resetFx();
    user('eva').orgRole = 'org_admin';
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { orgRole: 'member', confirmSelfDemotion: true }, session: JAN });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.hint.kind, 'role_downgrade');
    assert.strictEqual(fx.updates[0][1].orgRole, 'member');
});

test('demoting SOMEONE ELSE never asks the caller to confirm a self-demotion', async () => {
    resetFx();
    user('eva').orgRole = 'org_admin';
    const res = await dispatch({ method: 'PUT', url: '/users/eva', body: { orgRole: 'member' }, session: JAN });
    assert.strictEqual(res.statusCode, 200);
});

test('a role the product does not define ranks as a downgrade, not a sideways move', async () => {
    resetFx();
    user('eva').orgRole = 'org_admin';
    // 'owner' exists nowhere in config/orgRoles.json. The old hard-coded ladder
    // scored unknown roles as "member" and stayed silent; it must warn.
    const res = await dispatch({ method: 'PUT', url: '/users/eva', body: { orgRole: 'owner' }, session: SUPER });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.hint.kind, 'role_downgrade');
    assert.strictEqual(res.body.hint.to, 'owner');
});

// ═══ L-04 — unpermitted fields are named, not silently dropped ═══════

test('an unknown field is refused instead of answered with success', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/eva', body: { isAdmin: true }, session: SUPER });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'unknown_fields');
    assert.ok(res.body.error.includes('isAdmin'), res.body.error);
    assert.deepEqual(res.body.fields, ['isAdmin']);
    assert.deepEqual(fx.updates, []);
});

test('every unknown field is named, not just the first', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT',
        url: '/users/eva',
        body: { displayName: 'Eva', isAdmin: true, passwordHash: 'pre-hashed', permissions: ['all'] },
        session: SUPER,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepEqual(res.body.fields, ['isAdmin', 'passwordHash', 'permissions']);
});

test('a pre-hashed passwordHash cannot be smuggled in as an update', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/eva', body: { passwordHash: '$2a$10$attacker' }, session: SUPER });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'unknown_fields');
});

test('the whole row the admin panel PUTs back is still accepted', async () => {
    resetFx();
    // agent-hub UserManagement.jsx sends its entire userData object, which
    // carries `id` and `username` on top of the writable fields. Rejecting
    // those would break the panel, so they are allow-listed and ignored.
    const res = await dispatch({
        method: 'PUT',
        url: '/users/eva',
        body: {
            id: 'eva', username: 'eva', displayName: 'Eva', firstName: 'Eva', lastName: 'Jansen',
            email: 'eva@acme.nl', phone: '', avatar: '', avatarType: '', password: '',
            role: 'user', groups: ['g_fin'], organizationId: 'orgA', orgRole: 'member',
        },
        session: SUPER,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(fx.updates.length, 1);
    // `username` is an echo of the path identity — accepted, never written.
    assert.ok(!('username' in fx.updates[0][1]), 'username must not be applied from the body');
});

test('the narrow bodies the org users panel sends are still accepted', async () => {
    resetFx();
    for (const body of [{ orgRole: 'member' }, { groups: ['g_fin'] }, { status: 'active', orgRole: 'user' }]) {
        const res = await dispatch({ method: 'PUT', url: '/users/eva', body, session: SUPER });
        assert.strictEqual(res.statusCode, 200, `${JSON.stringify(body)} → ${JSON.stringify(res.body)}`);
    }
});

// ═══ M-01 — one password policy on every write path ══════════════════

test('PUT /users/:id no longer hashes whatever it is handed', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/eva', body: { password: 'x' }, session: SUPER });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'too_short');
    assert.deepEqual(fx.updates, []);
});

test('PUT /users/:id gives the validator the target\'s identity and reach', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/jan', body: { password: 'jan-is-my-password' }, session: SUPER });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'derived_from_identity');
    const ctx = fx.pwChecks.at(-1);
    assert.strictEqual(ctx.username, 'jan');
    assert.strictEqual(ctx.email, 'jan@acme.nl');
    assert.strictEqual(ctx.isAdmin, true, 'jan is an org_admin — the longer minimum applies');
});

test('PUT /users/:id still applies an acceptable password', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/users/eva', body: { password: 'Zeearend-9142' }, session: SUPER });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(fx.updates[0][1].passwordHash, 'the hash is still written');
});

// Pre-existing, found by driving the live stack: checkResourceLimits is async
// and the route did not await it, so the seat-limit guard tested a Promise for
// truthiness — always true. Creating ANY user inside an organisation returned
// 403 {"error":{}} (a serialised Promise). The admin panel's core action was
// broken, and the empty error body is why nobody could tell why.
test('a user can actually be created inside an organisation', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/users',
        body: { username: 'nieuw', displayName: 'Nieuw', password: 'Molenwiek-Fietsbel-42', organizationId: 'orgA', orgRole: 'member' },
        session: SUPER,
    });
    assert.strictEqual(res.statusCode, 200, `seat guard rejected a legitimate create: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.deepEqual(fx.created.map((u) => u.id), ['nieuw']);
});

test('POST /users cannot provision a one-character password', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST',
        url: '/users',
        body: { username: 'nieuw', password: 'x', organizationId: 'orgA' },
        session: SUPER,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'too_short');
    assert.deepEqual(fx.created, []);
});

test('POST /users holds a new org admin to the longer minimum', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST',
        url: '/users',
        body: { username: 'nieuw', password: 'Kortmaar-99', orgRole: 'org_admin', organizationId: 'orgA' },
        session: SUPER,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(fx.pwChecks.at(-1).isAdmin, true);
});

test('POST /users still creates with an acceptable password', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST',
        url: '/users',
        body: { username: 'nieuw', password: 'Zeearend-9142', organizationId: 'orgA' },
        session: SUPER,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(fx.created.length, 1);
});

test('the stub above still describes the real shared policy', () => {
    // The routes are exercised against the stub, so if ./passwordPolicy ever
    // changed shape the wiring could pass everything while looking green. This
    // pins the stub to the module the routes actually load in production: same
    // call signature, same {ok, error, code} result, same two floors.
    const real = require('./passwordPolicy');
    assert.strictEqual(typeof real.validatePassword, 'function');

    const weak = real.validatePassword('12345678', { username: 'eva', email: 'eva@acme.nl' });
    assert.strictEqual(weak.ok, false, 'the password the pentest set must be refused');
    assert.ok(typeof weak.error === 'string' && weak.error.length > 0, 'the refusal carries a message to show');
    assert.ok(typeof weak.code === 'string' && weak.code.length > 0, 'the refusal carries a machine-readable code');

    assert.strictEqual(real.validatePassword('x', {}).ok, false, 'one character is never enough');
    assert.strictEqual(real.validatePassword('Zeearend-9142', { username: 'eva', email: 'eva@acme.nl' }).ok, true);
    // The admin floor is real and higher: 9 characters pass for a member and
    // fail for an administrator.
    assert.strictEqual(real.validatePassword('Zeearend9', { username: 'eva' }).ok, true);
    assert.strictEqual(real.validatePassword('Zeearend9', { username: 'jan', isAdmin: true }).ok, false);
});

test('/change-password rejects the password the pentest set', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST',
        url: '/change-password',
        body: { oldPassword: OLD_PASSWORD, newPassword: '12345678' },
        session: EVA,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'common_password');
    assert.deepEqual(fx.updates, []);
});

test('/change-password no longer accepts four characters', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST',
        url: '/change-password',
        body: { oldPassword: OLD_PASSWORD, newPassword: 'abcd' },
        session: EVA,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'too_short');
});

test('/change-password holds an org admin to the longer minimum', async () => {
    resetFx();
    // Nine characters clears the floor for a member and not for jan, whose
    // orgRole is org_admin — the credential that unlocks the whole tenant.
    const res = await dispatch({
        method: 'POST',
        url: '/change-password',
        body: { oldPassword: OLD_PASSWORD, newPassword: 'Zeearend9' },
        session: JAN,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'too_short');
    assert.strictEqual(fx.pwChecks.at(-1).isAdmin, true);
});

test('/change-password still works for an acceptable password', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST',
        url: '/change-password',
        body: { oldPassword: OLD_PASSWORD, newPassword: 'Zeearend-91424' },
        session: JAN,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    assert.ok(fx.updates.some(([uid, u]) => uid === 'jan' && u.passwordHash));
});

test('/change-password still refuses a wrong current password', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST',
        url: '/change-password',
        body: { oldPassword: 'not-the-old-one', newPassword: 'Zeearend-91424' },
        session: JAN,
    });
    assert.strictEqual(res.statusCode, 401);
    assert.deepEqual(fx.updates, []);
});
