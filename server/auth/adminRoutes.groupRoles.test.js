/**
 * Group ROLES are a permission-granting field, and were unvalidated.
 *
 * POST /auth/groups and PUT /auth/groups/:id carefully check the `permissions`
 * array against the caller's own permission set ("Cannot assign permissions you
 * don't have") and then wrote `roles` straight through. But getUserPermissions
 * expands a group's roles into its members' permissions and short-circuits to
 * ['all'] the moment the union contains it, initDefaultRoles seeds a role with
 * id 'admin' whose permissions are ['all'], and roles are GLOBAL — not
 * org-scoped — so any role id can be named from any org.
 *
 * The ladder: a user holding only `manage_users` PUTs {"roles":["admin"]} onto
 * a group in their own org, adds themselves to it, and comes back with the
 * wildcard — clearing requireAdmin, every requirePermission(...) gate and
 * `admin_support`, which serves Bee Flow's own cross-tenant support inbox.
 *
 * These tests pin the property: the roles array can never raise the caller
 * above their own permission set. They also pin the two things that must keep
 * working — a super admin may still attach anything, and re-saving a group that
 * already carries such a role must not lock an org admin out of editing it.
 *
 * Harness follows adminRoutes.crossTenant.test.js.
 *
 * Run: cd server && node --test auth/adminRoutes.groupRoles.test.js
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
    callerPerms: ['manage_users', 'org_admin', 'page_chat'],
    createdGroups: [],
    groupUpdates: [],
    orgRolePermissions: {},
    orgRoleOverrides: {},
    permCacheBusts: 0,
};

const mw = (req, res, next) => next();

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
        createGroup: async (group) => { fx.createdGroups.push(group); return true; },
        updateGroup: async (id, updates) => {
            fx.groupUpdates.push([id, updates]);
            const g = fx.groups.find((x) => x.id === id);
            if (g) for (const [k, v] of Object.entries(updates)) if (v !== undefined) g[k] = v;
            return true;
        },
        logAccessAudit: async () => { },
    },
    '../permissions': {
        loadConfig: async () => ({ admin: { username: 'admin' } }),
        saveConfig: async () => { },
        requireAuth: mw,
        requireAdmin: mw,
        requireSuperAdmin: mw,
        requirePermission: () => mw,
        requireOrgAdmin: () => mw,
        requirePrimaryOrgAdmin: () => (req, _res, next) => { req.primaryOrgId = 'orgA'; next(); },
        requireActiveOrg: mw,
        requireActiveOrgForMutations: () => mw,
        getUserPermissions: async (userId, session) => (
            session?.isAdmin || session?.user?.role === 'admin' ? ['all'] : [...fx.callerPerms]
        ),
        hasPermission: async () => true,
        isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
        resolveUserOrgIds: async () => new Set(['orgA']),
        SYSTEM_PERMISSIONS: [],
        getOrgRolePermissions: () => fx.orgRolePermissions,
        OrgRoles: { ORG_ADMIN: 'org_admin' },
        isOrgAdminRole: (r) => r === 'org_admin' || r === 'admin',
        invalidatePermissionCache: () => { },
        invalidateAllPermissionCaches: () => { fx.permCacheBusts += 1; },
        invalidateUserExistenceCache: () => { },
    },
    // In-memory stand-in for the per-org override store, so the route can be
    // driven end to end without a config table.
    '../orgRolePolicy': {
        EDITABLE_PERMISSIONS: ['use_notebooks', 'use_forms', 'manage_agents'],
        async resolveOrgRolePermissions(orgId, defaults) {
            const ov = fx.orgRoleOverrides[orgId] || {};
            const out = {};
            for (const [role, perms] of Object.entries(defaults || {})) {
                out[role] = ov[role]
                    ? [...perms.filter((p) => !['use_notebooks', 'use_forms', 'manage_agents'].includes(p)), ...ov[role]]
                    : [...perms];
            }
            return out;
        },
        async setOrgRolePermissions(orgId, role, permissions) {
            const kept = (permissions || []).filter((p) => ['use_notebooks', 'use_forms', 'manage_agents'].includes(p));
            fx.orgRoleOverrides[orgId] = { ...(fx.orgRoleOverrides[orgId] || {}), [role]: kept };
            return kept;
        },
    },
    '../encryption': {
        rewrapUserDEKCompat: async () => ({ success: true }),
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
    const mockId = `mock:adminroutes-grouproles:${request}`;
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

const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const request = {
            method, url, body, query: {}, params: {}, headers: {},
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
        // A request-shape refusal travels as an HttpError to the terminal
        // handler rather than being answered inline, so the harness has to
        // answer one the way index.js does — otherwise a correct 400 arrives
        // here as a thrown error and reads as a broken route.
        router(request, res, (err) => {
            if (!err) return reject(new Error(`fell through router: ${method} ${url}`));
            terminalErrorHandler(err, request, res, (e) => reject(e));
        });
    });
}

// ── Fixtures ─────────────────────────────────────────────────────────
function resetFx() {
    fx.orgs = [{ id: 'orgA', name: 'Acme B.V.' }];
    fx.groups = [
        { id: 'finance', name: 'Finance', organizationId: 'orgA', permissions: [], roles: [] },
        // A group a SUPER admin legitimately gave the wildcard role to.
        { id: 'platform', name: 'Platform', organizationId: 'orgA', permissions: [], roles: ['admin'] },
    ];
    fx.roles = [
        { id: 'admin', name: 'Administrator', permissions: ['all'] },
        { id: 'support', name: 'Support', permissions: ['admin_support'] },
        { id: 'reader', name: 'Reader', permissions: ['page_chat'] },
    ];
    fx.users = [
        { id: 'jan', username: 'jan', email: 'jan@acme.nl', organizationId: 'orgA', orgRole: 'org_admin', role: 'user', groups: [], status: 'active' },
    ];
    fx.callerPerms = ['manage_users', 'org_admin', 'page_chat'];
    fx.createdGroups = [];
    fx.groupUpdates = [];
    fx.orgRolePermissions = {
        org_admin: ['org_admin', 'manage_users', 'use_approvals', 'use_notebooks'],
        member: ['use_approvals', 'use_apps', 'use_notebooks'],
    };
    fx.orgRoleOverrides = {};
    fx.permCacheBusts = 0;
}

const JAN = { isAuthenticated: true, user: { id: 'jan', role: 'user' } };
const ROOT = { isAuthenticated: true, isAdmin: true, user: { id: 'root', role: 'admin' } };

test('the router loaded with its dependencies stubbed', () => {
    assert.strictEqual(loadError, null, loadError && loadError.message);
    assert.strictEqual(typeof router, 'function');
});

// ═══ The escalation ══════════════════════════════════════════════════

// ═══ GET /org-roles ══════════════════════════════════════════════════
//
// The Organisation Roles screen renders from this, so it must return the
// resolver's own mapping rather than a description of it — a role listing that
// can disagree with what the server enforces is worse than none.

test('GET /org-roles returns the effective mapping and what may be changed', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/org-roles', session: JAN });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.roles, [
        { id: 'org_admin', permissions: ['org_admin', 'manage_users', 'use_approvals', 'use_notebooks'] },
        { id: 'member', permissions: ['use_approvals', 'use_apps', 'use_notebooks'] },
    ]);
    assert.ok(res.body.editablePermissions.includes('use_notebooks'),
        'the screen must be told what a PUT will accept, not guess');
});

test('PUT /org-roles/:roleId stores the org choice and GET reflects it', async () => {
    resetFx();
    // The whole point: an admin takes Notebooks away from Member.
    const put = await dispatch({
        method: 'PUT', url: '/org-roles/member', session: JAN,
        body: { permissions: ['use_forms'] },
    });
    assert.strictEqual(put.statusCode, 200);
    assert.deepStrictEqual(put.body, { id: 'member', permissions: ['use_forms'] });

    const res = await dispatch({ method: 'GET', url: '/org-roles', session: JAN });
    const member = res.body.roles.find((r) => r.id === 'member');
    assert.ok(!member.permissions.includes('use_notebooks'), 'Notebooks withdrawn');
    assert.ok(member.permissions.includes('use_forms'), 'Forms granted');
    // Permissions the org may NOT change survive untouched.
    assert.ok(member.permissions.includes('use_approvals'));
    assert.ok(member.permissions.includes('use_apps'));
    // The other role is unaffected — one PUT is one role.
    assert.ok(res.body.roles.find((r) => r.id === 'org_admin').permissions.includes('use_notebooks'));
});

test('PUT /org-roles refuses an unknown role and a non-array body', async () => {
    resetFx();
    const unknown = await dispatch({
        method: 'PUT', url: '/org-roles/wizard', session: JAN, body: { permissions: [] },
    });
    assert.strictEqual(unknown.statusCode, 404);

    const bad = await dispatch({
        method: 'PUT', url: '/org-roles/member', session: JAN, body: { permissions: 'all' },
    });
    assert.strictEqual(bad.statusCode, 400, '[] clears a list; a bare string is a mistake');
    assert.deepStrictEqual(fx.orgRoleOverrides, {}, 'nothing may be persisted');
});

test('PUT /org-roles busts the permission cache for the whole org', async () => {
    // Members hold the role; their resolved permissions are cached per user,
    // so a grant that does not invalidate is a grant nobody receives until the
    // TTL happens to lapse.
    resetFx();
    await dispatch({
        method: 'PUT', url: '/org-roles/member', session: JAN, body: { permissions: [] },
    });
    assert.strictEqual(fx.permCacheBusts, 1);
});

test('an org admin cannot attach the wildcard role to a group (PUT)', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { roles: ['admin'] } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.groupUpdates, [], 'nothing may be persisted');
});

test('an org admin cannot create a group carrying the wildcard role (POST)', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/groups', session: JAN, body: { name: 'Pwn', roles: ['admin'] } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.createdGroups, []);
});

test('a role granting a single permission the caller lacks is refused too', async () => {
    resetFx();
    // admin_support is not in fx.callerPerms — it opens the cross-tenant
    // company support inbox, so it must be as unassignable as 'all'.
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { roles: ['support'] } });
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /admin_support/);
});

test('an unknown role id is refused rather than silently stored', async () => {
    resetFx();
    // Roles are global; storing an id with no role behind it would activate
    // later, the moment someone creates a role with that id.
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { roles: ['not-yet-created'] } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.groupUpdates, []);
});

// ═══ What must keep working ══════════════════════════════════════════

test('a role whose permissions the caller already holds is assignable', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { roles: ['reader'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.groupUpdates[0][1].roles, ['reader']);
});

test('a super admin may still attach any role', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: ROOT, body: { roles: ['admin'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.groupUpdates[0][1].roles, ['admin']);
});

test('re-saving a group that already carries the role does not lock the org admin out', async () => {
    resetFx();
    // The edit form round-trips the current roles array; only ADDITIONS are
    // checked, so changing the description of a super-admin-configured group
    // must still succeed.
    const res = await dispatch({
        method: 'PUT', url: '/groups/platform', session: JAN,
        body: { description: 'Platform team', roles: ['admin'] },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.groupUpdates[0][1].description, 'Platform team');
});

test('removing a role is always allowed', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/groups/platform', session: JAN, body: { roles: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.groupUpdates[0][1].roles, []);
});

test('a caller holding "all" may assign anything', async () => {
    resetFx();
    fx.callerPerms = ['all'];
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { roles: ['admin'] } });
    assert.strictEqual(res.statusCode, 200);
});

test('the existing permissions guard is untouched', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { permissions: ['all'] } });
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /Cannot assign permissions you don't have/);
});

// ═══ Request shape ═══════════════════════════════════════════════════
//
// Everything above is about WHO may grant WHAT. This section is about the
// container: `permissions` and `roles` are string arrays everywhere they are
// READ. getUserPermissions walks them element by element, so a string is
// walked character by character ('admin' → 'a','d','m',…) and a plain object
// is not walked at all — the row ends up in a shape no reader expects, and
// nothing complains until someone's effective permission set is quietly wrong.
//
// Neither guard above can catch it. rejectUngrantableRoles opens with
// `if (!Array.isArray(requested)) return null` — safe (no character matches a
// role id) but silent, so the junk sails through to the column. The
// permissions guard is worse: it calls .filter() on whatever arrived, so a
// string threw a TypeError out of an async handler for an org admin, while a
// super admin skipped the guard entirely and stored the string verbatim.
//
// So the type is refused at the edge, and with **400** — a wrong request shape
// is a malformed request, not a privilege decision. That distinction is the
// reason these assert on the status code and not merely on "not 200".

test('PUT refuses a bare string for roles instead of storing it', async () => {
    resetFx();
    // Pre-repair this reached userStore.updateGroup as roles: 'admin' and the
    // handler answered 200 — the escalation guard had already bailed out on
    // !Array.isArray. Nothing may be persisted.
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { roles: 'admin' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /roles must be an array/);
    assert.deepStrictEqual(fx.groupUpdates, [], 'nothing may be persisted');
});

test('POST refuses a bare string for roles instead of storing it', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/groups', session: JAN, body: { name: 'Pwn', roles: 'admin' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /roles must be an array/);
    assert.deepStrictEqual(fx.createdGroups, [], 'nothing may be persisted');
});

test('PUT refuses roles: null — [] is how you clear a list, null is not', async () => {
    resetFx();
    // null is SUPPLIED, not omitted. userStore.updateGroup keys on
    // `!== undefined`, so null passed that filter, reached JSON.stringify and
    // wrote the literal `null` into groups.roles — which getUserPermissions
    // then tries to iterate. Only `undefined` may mean "field not sent".
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { roles: null } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /use \[\] to clear it, not null/);
    assert.deepStrictEqual(fx.groupUpdates, [], 'nothing may be persisted');
});

test('POST refuses roles: null for the same reason', async () => {
    resetFx();
    // POST happens to coerce with `roles || []`, so the column survived — but
    // the caller asked for something the API does not mean, and answering 200
    // teaches the client that null is a supported way to clear. Same 400.
    const res = await dispatch({ method: 'POST', url: '/groups', session: JAN, body: { name: 'Sales', roles: null } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /use \[\] to clear it, not null/);
    assert.deepStrictEqual(fx.createdGroups, [], 'nothing may be persisted');
});

test('PUT answers 400 for permissions: "all", not a 500 out of .filter', async () => {
    resetFx();
    // The permission guard does `permissions.filter(...)` once length > 0, and
    // 'all'.length is 3 — so a string reached .filter and threw a TypeError
    // out of the async handler, surfacing as a 500. A malformed body must
    // never be an unhandled exception.
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { permissions: 'all' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /permissions must be an array/);
    assert.deepStrictEqual(fx.groupUpdates, []);
});

test('POST answers 400 for permissions: "all", not a 500 out of .filter', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/groups', session: JAN, body: { name: 'Pwn', permissions: 'all' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /permissions must be an array/);
    assert.deepStrictEqual(fx.createdGroups, []);
});

test('PUT refuses an array of non-strings with 400, not 403', async () => {
    resetFx();
    // [123] used to come back 403 "123 (unknown role)" — the right outcome for
    // the wrong reason, and only by accident: it held solely because no role id
    // equals the number. The status matters, because the SPA shows a 403 as
    // "you are not allowed to do this" when the real answer is "you sent junk".
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { roles: [123] } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /roles must be an array of strings/);
    assert.deepStrictEqual(fx.groupUpdates, []);
});

test('POST refuses an array of non-strings with 400, not 403', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/groups', session: JAN, body: { name: 'Pwn', roles: [123] } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /roles must be an array of strings/);
    assert.deepStrictEqual(fx.createdGroups, []);
});

test('PUT also shape-checks allowedTiers', async () => {
    resetFx();
    // allowedTiers rides the same `!== undefined` path onto the row, so it can
    // write a bare string just as easily. (POST does not accept the field at
    // all, so there is nothing to assert there.)
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { allowedTiers: 'pro' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /allowedTiers must be an array/);
    assert.deepStrictEqual(fx.groupUpdates, []);
});

test('POST also shape-checks allowedAgentTypes', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/groups', session: JAN, body: { name: 'Pwn', allowedAgentTypes: 'chat' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /allowedAgentTypes must be an array/);
    assert.deepStrictEqual(fx.createdGroups, []);
});

// ── The shape check is not a privilege check ─────────────────────────
//
// A super admin skips every guard in these handlers, which is correct for
// "may I grant this?" and wrong for "is this even a roles array?". Being
// allowed to attach any role is not permission to write a string into a
// column the readers iterate — so the wrong shape must 400 for them too.

test('a super admin gets 400 for a string roles field as well', async () => {
    resetFx();
    // Pre-repair the super-admin path had no guard whatsoever between the body
    // and updateGroup, so this persisted roles: 'admin' and answered 200.
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: ROOT, body: { roles: 'admin' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.groupUpdates, [], 'nothing may be persisted');
});

test('a super admin gets 400 for a string permissions field on POST as well', async () => {
    resetFx();
    // The org-admin path threw here; the super-admin path stored 'all'
    // verbatim. Two different wrong answers to the same malformed body.
    const res = await dispatch({ method: 'POST', url: '/groups', session: ROOT, body: { name: 'Ops', permissions: 'all' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.createdGroups, [], 'nothing may be persisted');
});

test('a super admin gets 400 for an array of non-strings as well', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: ROOT, body: { roles: [123] } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.groupUpdates, []);
});

// ── What the shape check must NOT break ──────────────────────────────
//
// The whole risk of validating at the edge is over-reach: the admin SPA sends
// PARTIAL updates, so an omitted field is normal traffic and must stay normal.
// These three are the guard rails against a future "tighten the validation"
// change turning every description edit into a 400.

test('a description-only PUT still succeeds — the SPA sends partial updates', async () => {
    resetFx();
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', session: JAN, body: { description: 'Finance team' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.groupUpdates[0][1].description, 'Finance team');
    // Omitted stays omitted: undefined is what updateGroup filters on, so the
    // roles column must not be touched by an edit that never mentioned it.
    assert.strictEqual(fx.groupUpdates[0][1].roles, undefined, 'an unsent field must stay unsent');
});

test('an empty roles array still clears the list — this is the null case done right', async () => {
    resetFx();
    // The counterpart to the roles: null test above: [] is the supported way
    // to empty the list, and rejecting null is only defensible while [] works.
    const res = await dispatch({ method: 'PUT', url: '/groups/platform', session: JAN, body: { roles: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.groupUpdates[0][1].roles, []);
});

test('POST with an empty roles array, and POST with no roles at all, both still work', async () => {
    resetFx();
    const empty = await dispatch({ method: 'POST', url: '/groups', session: JAN, body: { name: 'Empty', roles: [], permissions: [] } });
    assert.strictEqual(empty.statusCode, 200);
    assert.deepStrictEqual(fx.createdGroups[0].roles, []);

    resetFx();
    const omitted = await dispatch({ method: 'POST', url: '/groups', session: JAN, body: { name: 'Plain' } });
    assert.strictEqual(omitted.statusCode, 200);
    assert.deepStrictEqual(fx.createdGroups[0].roles, [], 'an omitted roles field still defaults to []');
});
