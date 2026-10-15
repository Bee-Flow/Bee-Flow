/**
 * auth/permissions — characterisation ("golden") test.
 *
 * Written BEFORE permissions.js was split into its sibling modules, against the
 * single 1406-line file, and kept unchanged across the split: every assertion
 * below is what the monolith answered. It pins
 *
 *   - the public surface: the exact export keys (in order), the gate tags the
 *     Access Map reads, and the function names the route-table walk reads;
 *   - getUserPermissions: the ORDER in which the sources are layered (session
 *     admin → cache → user row → legacy admin → groups (perms, implied
 *     capability, roles) → direct role → orgRole → org-wide grant → group
 *     orgRole → 'all' short-circuit → page_chat floor → cache write) and the
 *     degraded fallback;
 *   - requireAuth: 401 → Microsoft session → existence (cached) → 503 on a
 *     store error → 401 + destroy for a deleted account → isAdmin revalidation
 *     → last-seen → next;
 *   - the RBAC, org-lifecycle, org-admin and super-admin gates with their exact
 *     status codes and bodies, and the Studio org/group helpers;
 *   - the cache: in-memory hit, per-user and bulk invalidation, and the Redis
 *     key / TTL / pub-sub fan-out.
 *
 * The stores are doubles, installed by require string (testUtils/stubRequire),
 * so they hold for the monolith and for every module the split produced.
 *
 * Run: cd server && node --test auth/permissions.characterisation.test.js
 */

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');

// ── Fixture + doubles ────────────────────────────────────────────────────────
const fx = {
    users: {},
    groups: [],
    roles: [],
    orgs: {},
    betaEveryone: {},     // orgId -> org_beta_everyone (undefined = null = never chosen)
    roleOverrides: {},    // orgId -> { role: [perms] }
    groupsThrow: false,
    userThrows: false,
    orgThrows: false,
    msAccept: true,
};
const calls = [];         // ordered record of store / session calls
let currentRedis = null;

const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => {
            calls.push(['getUser', id]);
            if (fx.userThrows) throw new Error('user store unreachable');
            return fx.users[id] || null;
        },
        getAllGroups: async () => {
            calls.push(['getAllGroups']);
            if (fx.groupsThrow) throw new Error('group store unreachable');
            return fx.groups;
        },
        getAllRoles: async () => { calls.push(['getAllRoles']); return fx.roles; },
        getOrganization: async (id) => {
            calls.push(['getOrganization', id]);
            if (fx.orgThrows) throw new Error('org store unreachable');
            return fx.orgs[id] || null;
        },
        getOrgBetaEveryone: async (orgId) => {
            calls.push(['getOrgBetaEveryone', orgId]);
            return fx.betaEveryone[orgId] === undefined ? null : fx.betaEveryone[orgId];
        },
        touchLastSeen: async (id) => { calls.push(['touchLastSeen', id]); return true; },
    },
    '../db': { getRedis: () => currentRedis },
    './microsoftSession': {
        validateMicrosoftSession: async (req, res, next) => {
            calls.push(['msSession']);
            if (fx.msAccept) return next();
            return res.status(401).json({ error: 'microsoft_session_revoked' });
        },
    },
    './orgRolePolicy': {
        getOrgRoleOverrides: async (orgId) => {
            calls.push(['getOrgRoleOverrides', orgId]);
            return fx.roleOverrides[orgId] || {};
        },
        resolveOrgRolePermissions: async (orgId, defaults) => {
            calls.push(['resolveOrgRolePermissions', orgId]);
            return { ...defaults, ...(fx.roleOverrides[orgId] || {}) };
        },
    },
    '../stores/authConfigStore': {
        load: async () => ({ loaded: true }),
        save: async (c) => ({ saved: c }),
    },
};
// Keyed on the require string, so the doubles reach every module that asks
// for these, whichever auth/permissions*.js file that is.
const restore = installResolveStub(MOCKS);
after(() => restore());

const perms = require('./permissions');
const { readGate } = require('./gateMeta');
const { buildKey } = require('../utils/buildInfo');

beforeEach(async () => {
    fx.users = {}; fx.groups = []; fx.roles = []; fx.orgs = {};
    fx.betaEveryone = {}; fx.roleOverrides = {};
    fx.groupsThrow = false; fx.userThrows = false; fx.orgThrows = false; fx.msAccept = true;
    currentRedis = null;
    await perms.invalidateAllPermissionCaches();
    for (const id of Object.keys(fx.users)) await perms.invalidateUserExistenceCache(id);
    calls.length = 0;
});

function mkRes() {
    return {
        statusCode: 200, body: undefined,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
}
function session(user, extra = {}) {
    let destroyed = false;
    return {
        isAuthenticated: true, isAdmin: false, user, ...extra,
        destroy(cb) { destroyed = true; if (cb) cb(); },
        get destroyed() { return destroyed; },
    };
}
async function run(mw, req) {
    const res = mkRes();
    let nexted = false;
    await mw(req, res, () => { nexted = true; });
    return { res, nexted, status: nexted ? 'next' : res.statusCode, body: res.body };
}
const tick = () => new Promise((r) => setImmediate(r));

// ── 1. Public surface ────────────────────────────────────────────────────────
test('export keys are exactly the monolith\'s, in order', () => {
    assert.deepEqual(Object.keys(perms), [
        'SYSTEM_PERMISSIONS', 'getOrgRolePermissions', 'OAUTH_PROVIDERS', 'MICROSOFT_SCOPES',
        'microsoftRefreshScope', 'loadConfig', 'saveConfig', 'requireAuth', 'getUserPermissions',
        'resolveUserPermissionsForAudit', 'hasPermission', 'requireAdmin', 'requireSuperAdmin',
        'requirePermission', 'requirePluginAdmin', 'resolveUserOrgIds', 'resolvePrimaryOrgId',
        'isSuperAdmin', 'isSuperAdminUser', 'isOrgAdminForOrg', '_evalOrgAdmin', 'requireOrgAdmin',
        'requirePrimaryOrgAdmin', 'assertUserCanUseOrg', 'validateSharedGroupsForOrg',
        'invalidatePermissionCache', 'invalidateAllPermissionCaches', 'invalidateUserExistenceCache',
        'GROUP_GRANT_IMPLIED_PERMISSIONS', 'orgWideGrantImpliedPermissions', 'orgRoleImpliedFill',
        'OrgRoles', 'SystemRoles', 'Permissions', 'ORG_ADMIN_VARIANTS', 'isOrgAdminRole',
        'requireActiveOrg', 'requireActiveOrgForMutations', 'isPermissionLookupDegraded',
    ]);
});

test('gate names and tags are unchanged', () => {
    assert.equal(perms.requireAuth.name, 'requireAuth');
    assert.equal(perms.requireAdmin.name, 'requireAdmin');
    assert.equal(perms.requirePluginAdmin.name, 'requirePluginAdmin');
    assert.equal(perms.requireSuperAdmin.name, 'requireSuperAdmin');
    assert.deepEqual(readGate(perms.requireAuth), { axis: 'auth' });
    assert.deepEqual(readGate(perms.requireAdmin), { axis: 'rbac', anyOf: ['manage_users', 'all'] });
    assert.deepEqual(readGate(perms.requirePluginAdmin), { axis: 'rbac', anyOf: ['admin_components', 'all'] });
    assert.deepEqual(readGate(perms.requireSuperAdmin), { axis: 'platform', kind: 'superAdmin' });
    assert.deepEqual(readGate(perms.requirePermission('use_forms')), { axis: 'rbac', anyOf: ['use_forms', 'all'] });
    assert.deepEqual(readGate(perms.requireActiveOrg()), { axis: 'orgStatus', paramName: 'orgId', mutationsOnly: false, failsOpen: true });
    assert.deepEqual(readGate(perms.requireActiveOrg({ paramName: 'p' })), { axis: 'orgStatus', paramName: 'p', mutationsOnly: false, failsOpen: true });
    assert.deepEqual(readGate(perms.requireActiveOrgForMutations()), { axis: 'orgStatus', paramName: 'orgId', mutationsOnly: true, failsOpen: true });
    assert.deepEqual(readGate(perms.requireOrgAdmin()), { axis: 'scope', kind: 'orgAdminOfParam', param: 'id', paramDependent: true });
    assert.deepEqual(readGate(perms.requireOrgAdmin('orgId')), { axis: 'scope', kind: 'orgAdminOfParam', param: 'orgId', paramDependent: true });
    assert.deepEqual(readGate(perms.requirePrimaryOrgAdmin()), { axis: 'scope', kind: 'orgAdminOfOwnOrg' });
});

test('catalogue constants and OAuth providers', async () => {
    assert.equal(perms.SYSTEM_PERMISSIONS.length, 34);
    assert.equal(perms.SYSTEM_PERMISSIONS[0].id, 'all');
    assert.equal(perms.SYSTEM_PERMISSIONS.at(-1).id, 'modify_n8n_workflows');
    assert.equal(Object.keys(perms.Permissions).length, 31);
    assert.deepEqual(perms.ORG_ADMIN_VARIANTS, ['org_admin', 'admin']);
    assert.equal(perms.isOrgAdminRole('admin'), true);
    assert.equal(perms.isOrgAdminRole('dpo'), false);
    assert.deepEqual(perms.SystemRoles, { SUPER_ADMIN: 'admin', USER: 'user' });
    assert.deepEqual(perms.GROUP_GRANT_IMPLIED_PERMISSIONS, { meeting_notes: ['use_meeting_notes'] });
    assert.ok(Object.isFrozen(perms.OrgRoles) && Object.isFrozen(perms.Permissions));
    assert.strictEqual(perms.getOrgRolePermissions(), perms.getOrgRolePermissions(), 'memoised');
    assert.deepEqual(Object.keys(perms.OAUTH_PROVIDERS), ['google', 'microsoft', 'nextcloud', 'withings']);
    assert.strictEqual(perms.OAUTH_PROVIDERS.microsoft.scopes, perms.MICROSOFT_SCOPES);
    assert.equal(perms.OAUTH_PROVIDERS.microsoft.authUrl('t1'), 'https://login.microsoftonline.com/t1/oauth2/v2.0/authorize');
    assert.equal(perms.OAUTH_PROVIDERS.microsoft.tokenUrl(), 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    assert.equal(perms.microsoftRefreshScope('  a b  '), 'a b');
    assert.equal(perms.microsoftRefreshScope(''), perms.MICROSOFT_SCOPES.join(' '));
    assert.equal(perms.microsoftRefreshScope(null), perms.MICROSOFT_SCOPES.join(' '));
    assert.deepEqual(await perms.loadConfig(), { loaded: true });
    assert.deepEqual(await perms.saveConfig({ a: 1 }), { saved: { a: 1 } });
});

test('orgRoleImpliedFill and orgWideGrantImpliedPermissions', async () => {
    assert.deepEqual(
        perms.orgRoleImpliedFill({ member: ['a'], dpo: ['b'] }, { dpo: ['b'] }, ['use_meeting_notes', 'a']),
        { member: ['a', 'use_meeting_notes'], dpo: ['b'] },
    );
    assert.deepEqual(perms.orgRoleImpliedFill(null, null, null), {});
    assert.deepEqual(await perms.orgWideGrantImpliedPermissions(null), []);
    assert.deepEqual(await perms.orgWideGrantImpliedPermissions('o1'), ['use_meeting_notes']);
    fx.betaEveryone.o1 = ['other'];
    assert.deepEqual(await perms.orgWideGrantImpliedPermissions('o1'), []);
    fx.betaEveryone.o1 = ['meeting_notes'];
    assert.deepEqual(await perms.orgWideGrantImpliedPermissions('o1'), ['use_meeting_notes']);
});

// ── 2. getUserPermissions: layering order ───────────────────────────────────
test('session admin short-circuits before any lookup', async () => {
    assert.deepEqual(await perms.getUserPermissions('x', { isAdmin: true }), ['all']);
    assert.deepEqual(calls, []);
});

test('unknown user → page_chat; role admin → all', async () => {
    assert.deepEqual(await perms.getUserPermissions('nobody'), ['page_chat']);
    fx.users.root = { id: 'root', role: 'admin' };
    assert.deepEqual(await perms.getUserPermissions('root'), ['all']);
});

test('member: groups, implied capability, roles, direct role, orgRole, then page_chat', async () => {
    fx.users.m1 = { id: 'm1', role: 'r2', orgRole: 'member', groups: JSON.stringify(['g1', 'gX']), organizationId: 'orgA' };
    fx.groups = [{ id: 'g1', organizationId: 'orgA', permissions: ['use_forms'], granted_capabilities: ['meeting_notes'], roles: ['r1', 'missing'] }];
    fx.roles = [{ id: 'r1', permissions: ['manage_skills'] }, { id: 'r2', permissions: ['use_apps', 'use_forms'] }];
    fx.betaEveryone.orgA = [];
    fx.roleOverrides.orgA = { member: ['use_notebooks'] };
    const got = await perms.getUserPermissions('m1');
    assert.deepEqual(got, ['use_forms', 'use_meeting_notes', 'manage_skills', 'use_apps', 'use_notebooks', 'page_chat']);
    assert.deepEqual(calls, [
        ['getUser', 'm1'], ['getAllGroups'], ['getAllRoles'],
        ['resolveOrgRolePermissions', 'orgA'], ['getOrgRoleOverrides', 'orgA'],
    ]);
});

test('legacy admin orgRole normalised; org-wide grant only for an undecided role', async () => {
    fx.users.la = { id: 'la', role: 'user', orgRole: 'admin', groups: [], organizationId: 'orgA' };
    const got = await perms.getUserPermissions('la');
    assert.deepEqual(got, [...perms.getOrgRolePermissions().org_admin.filter((p, i, a) => a.indexOf(p) === i), 'page_chat']);

    fx.users.mm = { id: 'mm', role: 'user', orgRole: 'member', groups: [], organizationId: 'orgB' };
    calls.length = 0;
    const undecided = await perms.getUserPermissions('mm');
    assert.ok(undecided.includes('use_meeting_notes'), 'null everyone-list implies the permission');
    assert.equal(calls.filter((c) => c[0] === 'getOrgBetaEveryone').length, 1);

    fx.roleOverrides.orgC = { member: ['use_apps'] };
    fx.users.md = { id: 'md', role: 'user', orgRole: 'member', groups: [], organizationId: 'orgC' };
    calls.length = 0;
    assert.deepEqual(await perms.getUserPermissions('md'), ['use_apps', 'page_chat']);
    assert.equal(calls.filter((c) => c[0] === 'getOrgBetaEveryone').length, 0, 'a decided role never reads the everyone-list');
});

test('group orgRole resolves in the GROUP\'s org; a group with all short-circuits', async () => {
    fx.users.g = { id: 'g', role: 'user', groups: ['gd'], organizationId: 'orgA' };
    fx.betaEveryone.orgA = [];
    fx.groups = [{ id: 'gd', organizationId: 'orgD', orgRole: 'dpo' }];
    fx.roleOverrides.orgD = { dpo: ['dpo', 'use_forms'] };
    assert.deepEqual(await perms.getUserPermissions('g'), ['dpo', 'use_forms', 'page_chat']);
    assert.deepEqual(calls.filter((c) => c[0] === 'resolveOrgRolePermissions'), [['resolveOrgRolePermissions', 'orgD']]);

    fx.users.ga = { id: 'ga', role: 'user', groups: ['gall'], organizationId: null };
    fx.groups = [{ id: 'gall', permissions: ['all', 'use_forms'] }];
    assert.deepEqual(await perms.getUserPermissions('ga'), ['all']);
});

test('a store error degrades to page_chat and flips the degraded flag', async () => {
    fx.users.e = { id: 'e', role: 'user', groups: [] };
    fx.groupsThrow = true;
    const origError = console.error;
    console.error = () => {};
    try {
        assert.deepEqual(await perms.getUserPermissions('e'), ['page_chat']);
    } finally { console.error = origError; }
    assert.equal(perms.isPermissionLookupDegraded(), true);
    fx.groupsThrow = false;
    // Not cached: the next call resolves again.
    calls.length = 0;
    await perms.getUserPermissions('e');
    assert.equal(calls[0][0], 'getUser');
});

test('in-memory cache: hit, per-user invalidation, bulk invalidation', async () => {
    fx.users.c = { id: 'c', role: 'user', groups: [], organizationId: null };
    fx.roles = [{ id: 'user', permissions: ['use_forms'] }];
    assert.deepEqual(await perms.getUserPermissions('c'), ['use_forms', 'page_chat']);
    calls.length = 0;
    fx.roles = [];
    assert.deepEqual(await perms.getUserPermissions('c'), ['use_forms', 'page_chat'], 'served from cache');
    assert.deepEqual(calls, []);
    await perms.invalidatePermissionCache('c');
    assert.deepEqual(await perms.getUserPermissions('c'), ['page_chat']);
    fx.roles = [{ id: 'user', permissions: ['use_apps'] }];
    assert.deepEqual(await perms.getUserPermissions('c'), ['page_chat']);
    await perms.invalidateAllPermissionCaches();
    assert.deepEqual(await perms.getUserPermissions('c'), ['use_apps', 'page_chat']);
});

test('audit lookup ignores the caller session; hasPermission honours all', async () => {
    fx.users.t = { id: 't', role: 'user', groups: [] };
    assert.deepEqual(await perms.resolveUserPermissionsForAudit('t', { isAdmin: true }), ['page_chat']);
    assert.equal(await perms.hasPermission('t', 'page_chat'), true);
    assert.equal(await perms.hasPermission('t', 'use_forms'), false);
    assert.equal(await perms.hasPermission('t', 'use_forms', { isAdmin: true }), true);
});

// ── 3. requireAuth ───────────────────────────────────────────────────────────
test('requireAuth: 401 without a session, before the Microsoft check', async () => {
    for (const req of [{}, { session: { isAuthenticated: false, user: {} } }, { session: { isAuthenticated: true } }]) {
        const r = await run(perms.requireAuth, req);
        assert.deepEqual([r.status, r.body], [401, { error: 'Not authenticated' }]);
    }
    assert.deepEqual(calls, []);
});

test('requireAuth: a refused Microsoft session stops before the existence check', async () => {
    fx.msAccept = false;
    const r = await run(perms.requireAuth, { session: session({ id: 'u' }) });
    assert.deepEqual([r.status, r.body], [401, { error: 'microsoft_session_revoked' }]);
    assert.deepEqual(calls, [['msSession']]);
});

test('requireAuth: existence, isAdmin revalidation, last seen, next — then cached', async () => {
    fx.users.ok = { id: 'ok', role: 'admin' };
    const req = { session: session({ id: 'ok', role: 'user' }) };
    const r = await run(perms.requireAuth, req);
    assert.equal(r.status, 'next');
    assert.equal(req.session.isAdmin, true);
    assert.equal(req.session.user.role, 'admin');
    assert.equal(req.session.user.isAdmin, true);
    await tick(); await tick();
    assert.deepEqual(calls, [['msSession'], ['getUser', 'ok'], ['getUser', 'ok'], ['touchLastSeen', 'ok']]);

    calls.length = 0;
    const r2 = await run(perms.requireAuth, { session: session({ id: 'ok', role: 'admin' }, { isAdmin: true }) });
    assert.equal(r2.status, 'next');
    await tick();
    assert.deepEqual(calls, [['msSession'], ['getUser', 'ok']], 'existence cached, last seen throttled');
});

test('requireAuth: a deleted account is signed out; a store error is 503', async () => {
    const req = { session: session({ id: 'gone' }) };
    const r = await run(perms.requireAuth, req);
    assert.deepEqual([r.status, r.body], [401, { error: 'User no longer exists' }]);
    assert.equal(req.session.destroyed, true);

    fx.userThrows = true;
    const origError = console.error;
    console.error = () => {};
    try {
        const r2 = { res: mkRes(), err: null, nexted: false };
        await perms.requireAuth({ session: session({ id: 'down' }) }, r2.res, (e) => { r2.nexted = true; r2.err = e; });
        // forwarded to the terminal handler as an HttpError; nothing written here
        assert.deepEqual([r2.err.status, r2.err.code, r2.err.message, r2.err.expose], [503, 'auth_unavailable', 'auth_unavailable', true]);
        assert.equal(r2.res.statusCode, 200);
    } finally { console.error = origError; }
});

test('requireAuth: a session without user id passes straight on', async () => {
    const r = await run(perms.requireAuth, { session: session({}) });
    assert.equal(r.status, 'next');
    assert.deepEqual(calls, [['msSession']]);
});

// ── 4. RBAC gates ────────────────────────────────────────────────────────────
test('requireAdmin / requirePermission / requirePluginAdmin', async () => {
    fx.users.p = { id: 'p', role: 'user', groups: ['gp'] };
    fx.groups = [{ id: 'gp', permissions: ['manage_users', 'use_forms'] }];
    const anon = { session: { isAuthenticated: false } };
    const p = { session: session({ id: 'p' }) };
    const plain = { session: session({ id: 'plain' }) };
    fx.users.plain = { id: 'plain', role: 'user', groups: [] };

    assert.deepEqual((await run(perms.requireAdmin, anon)).body, { error: 'Not authenticated' });
    assert.equal((await run(perms.requireAdmin, p)).status, 'next');
    assert.deepEqual(await run(perms.requireAdmin, plain).then((r) => [r.status, r.body]), [403, { error: 'Admin access required' }]);

    const gate = perms.requirePermission('use_forms');
    assert.equal((await run(gate, anon)).status, 401);
    assert.equal((await run(gate, p)).status, 'next');
    assert.deepEqual(await run(gate, plain).then((r) => [r.status, r.body]), [403, { error: "Permission 'use_forms' required" }]);

    assert.equal((await run(perms.requirePluginAdmin, anon)).status, 401);
    assert.deepEqual(await run(perms.requirePluginAdmin, p).then((r) => [r.status, r.body]), [403, { error: 'Plugin Admin access required' }]);
    assert.equal((await run(perms.requirePluginAdmin, { session: session({ id: 'p' }, { isAdmin: true }) })).status, 'next');
});

// ── 5. Org lifecycle gate ────────────────────────────────────────────────────
test('requireActiveOrg: caller org, param, member body org; never a stranger body org', async () => {
    fx.users.u = { id: 'u', role: 'user', organizationId: 'home', groups: ['g2'] };
    fx.groups = [{ id: 'g2', organizationId: 'second' }];
    fx.orgs = { home: { status: 'active' }, second: { status: 'suspended' }, arch: { status: 'archived' }, stranger: { status: 'suspended' } };
    const gate = perms.requireActiveOrg();

    assert.equal((await run(gate, { session: session({ id: 'u' }), params: {}, body: {} })).status, 'next');
    const viaBody = await run(gate, { session: session({ id: 'u' }), params: {}, body: { organizationId: 'second' } });
    assert.deepEqual([viaBody.status, viaBody.body], [402, { error: 'org_suspended', message: 'Your organization is currently suspended. Please contact your administrator.' }]);
    assert.equal((await run(gate, { session: session({ id: 'u' }), params: {}, body: { organizationId: 'stranger' } })).status, 'next');
    const viaParam = await run(gate, { session: session({ id: 'u' }), params: { orgId: 'arch' }, body: {} });
    assert.deepEqual([viaParam.status, viaParam.body], [410, { error: 'org_archived', message: 'Your organization is archived and read-only.' }]);

    calls.length = 0;
    await run(gate, { session: session({ id: 'u' }), params: { orgId: 'p1' }, body: { organizationId: 'second' } });
    assert.deepEqual(calls.filter((c) => c[0] === 'getOrganization').map((c) => c[1]), ['p1', 'second'], 'order: param, body, caller (stops on first blocked)');

    calls.length = 0;
    fx.orgs.second.status = 'active';
    await run(gate, { session: session({ id: 'u' }), params: { orgId: 'p1' }, body: { organizationId: 'second' } });
    assert.deepEqual(calls.filter((c) => c[0] === 'getOrganization').map((c) => c[1]), ['p1', 'second', 'home']);
});

test('requireActiveOrg: super admin, no org, fail-open; mutations-only variant', async () => {
    const gate = perms.requireActiveOrg();
    assert.equal((await run(gate, { session: session({ id: 'x', role: 'admin' }) })).status, 'next');
    assert.deepEqual(calls, []);
    fx.users.n = { id: 'n', role: 'user', groups: [] };
    assert.equal((await run(gate, { session: session({ id: 'n' }), params: {}, body: {} })).status, 'next');

    fx.users.f = { id: 'f', role: 'user', organizationId: 'o', groups: [] };
    fx.orgThrows = true;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        assert.equal((await run(gate, { session: session({ id: 'f' }), params: {}, body: {} })).status, 'next');
    } finally { console.warn = origWarn; }
    fx.orgThrows = false;

    fx.orgs.o = { status: 'suspended' };
    const mut = perms.requireActiveOrgForMutations();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        assert.equal((await run(mut, { method, session: session({ id: 'f' }), params: {}, body: {} })).status, 'next');
    }
    assert.equal((await run(mut, { method: 'POST', session: session({ id: 'f' }), params: {}, body: {} })).status, 402);
});

// ── 6. Org admin + super admin ───────────────────────────────────────────────
test('requireOrgAdmin', async () => {
    const gate = perms.requireOrgAdmin('id');
    assert.deepEqual(await run(gate, { session: {} }).then((r) => [r.status, r.body]), [401, { error: 'Unauthorized' }]);
    assert.deepEqual(await run(gate, { session: session({ id: 'a' }), params: {} }).then((r) => [r.status, r.body]), [400, { error: 'Organization ID required' }]);
    assert.equal((await run(gate, { session: session({ id: 'a', role: 'admin' }), params: { id: 'o' } })).status, 'next');
    assert.deepEqual(await run(gate, { session: session({}), params: { id: 'o' } }).then((r) => [r.status, r.body]), [403, { error: 'Organization admin access required' }]);

    fx.users.mem = { id: 'mem', orgRole: 'member', organizationId: 'o' };
    fx.users.oa = { id: 'oa', orgRole: 'org_admin', organizationId: 'o', groups: ['g'] };
    fx.groups = [{ id: 'g', organizationId: 'o2' }];
    assert.equal((await run(gate, { session: session({ id: 'mem' }), params: { id: 'o' } })).status, 403);
    assert.equal((await run(gate, { session: session({ id: 'oa' }), params: { id: 'o' } })).status, 'next');
    assert.equal((await run(gate, { session: session({ id: 'oa' }), params: { id: 'o2' } })).status, 'next');
    assert.equal((await run(gate, { session: session({ id: 'oa' }), params: { id: 'o3' } })).status, 403);
});

test('isOrgAdminForOrg / _evalOrgAdmin', async () => {
    const groups = [{ id: 'g', organizationId: 'o2', roles: ['org_admin'] }, { id: 'h', organizationId: 'o3', permissions: ['admin'] }];
    assert.equal(perms._evalOrgAdmin(null, groups, 'o'), false);
    assert.equal(perms._evalOrgAdmin({ orgRole: 'admin', organizationId: 'o' }, groups, 'o'), true);
    assert.equal(perms._evalOrgAdmin({ orgRole: 'admin', organizationId: 'o' }, groups, 'o', { strictOrgRole: true }), false);
    assert.equal(perms._evalOrgAdmin({ orgRole: 'member', groups: '["g"]' }, groups, 'o2'), true);
    assert.equal(perms._evalOrgAdmin({ orgRole: 'member', groups: ['h'] }, groups, 'o3'), true);
    assert.equal(perms._evalOrgAdmin({ orgRole: 'member', groups: 'nope' }, groups, 'o3'), false);

    assert.equal(await perms.isOrgAdminForOrg({ session: { isAdmin: true } }, 'o'), true);
    assert.equal(await perms.isOrgAdminForOrg({ session: {} }, 'o'), false);
    fx.users.z = { id: 'z', orgRole: 'org_admin', organizationId: 'o' };
    assert.equal(await perms.isOrgAdminForOrg({ session: { user: { id: 'z' } } }, 'o'), true);
    assert.equal(await perms.isOrgAdminForOrg({ session: { user: { id: 'missing' } } }, 'o'), false);
});

test('super admin predicates and gate', async () => {
    assert.equal(perms.isSuperAdmin({ session: { isAdmin: true } }), true);
    assert.equal(perms.isSuperAdmin({ session: { user: { role: 'admin' } } }), true);
    assert.equal(perms.isSuperAdmin({}), false);
    assert.equal(perms.isSuperAdminUser({ role: 'admin' }), true);
    assert.equal(perms.isSuperAdminUser(null), false);
    assert.deepEqual(await run(perms.requireSuperAdmin, { session: {} }).then((r) => [r.status, r.body]), [401, { error: 'Unauthorized' }]);
    assert.deepEqual(await run(perms.requireSuperAdmin, { session: { user: { id: 'u' } } }).then((r) => [r.status, r.body]), [403, { error: 'Operator access required' }]);
    assert.equal((await run(perms.requireSuperAdmin, { session: { user: { id: 'u', role: 'admin' } } })).status, 'next');
});

test('resolveUserOrgIds / resolvePrimaryOrgId / requirePrimaryOrgAdmin', async () => {
    fx.users.u = { id: 'u', orgRole: 'org_admin', organizationId: 'home', groups: ['g'] };
    fx.groups = [{ id: 'g', organizationId: 'other' }];
    assert.equal(await perms.resolveUserOrgIds({ session: { isAdmin: true, user: { id: 'u' } } }), null);
    assert.deepEqual([...await perms.resolveUserOrgIds({ session: { user: { id: 'u' } } })], ['home', 'other']);
    assert.equal(await perms.resolvePrimaryOrgId({ session: { user: { id: 'u' } } }), 'home');
    assert.equal(await perms.resolvePrimaryOrgId({ session: { isAdmin: true, user: { id: 'u' } } }), null);

    const gate = perms.requirePrimaryOrgAdmin();
    assert.equal((await run(gate, { session: {} })).status, 401);
    const req = { session: session({ id: 'u' }) };
    assert.equal((await run(gate, req)).status, 'next');
    assert.equal(req.primaryOrgId, 'home');
    fx.users.m = { id: 'm', orgRole: 'member', organizationId: 'home' };
    assert.deepEqual(await run(gate, { session: session({ id: 'm' }) }).then((r) => [r.status, r.body]), [403, { error: 'Organization admin access required' }]);
    const sa = { session: session({ id: 'sa', role: 'admin', organizationId: 'fallback' }) };
    assert.equal((await run(gate, sa)).status, 'next');
    assert.equal(sa.primaryOrgId, 'fallback');
    assert.deepEqual(await run(gate, { session: session({ id: 'sa2', role: 'admin' }) }).then((r) => [r.status, r.body]), [400, { error: 'No organization for this account' }]);
});

// ── 7. Studio helpers ────────────────────────────────────────────────────────
test('assertUserCanUseOrg', async () => {
    fx.users.u = { id: 'u', organizationId: 'home', groups: [] };
    fx.users.none = { id: 'none', groups: [] };
    assert.equal(await perms.assertUserCanUseOrg({ session: { isAdmin: true, user: { id: 'u' } } }, 'any'), 'any');
    assert.equal(await perms.assertUserCanUseOrg({ session: { isAdmin: true, user: { id: 'u' } } }), null);
    assert.equal(await perms.assertUserCanUseOrg({ session: { user: { id: 'u' } } }), 'home');
    assert.equal(await perms.assertUserCanUseOrg({ session: { user: { id: 'u' } } }, 'home'), 'home');
    await assert.rejects(perms.assertUserCanUseOrg({ session: { user: { id: 'u' } } }, 'x'), { message: 'Organisation not accessible', status: 403 });
    await assert.rejects(perms.assertUserCanUseOrg({ session: { user: { id: 'none' } } }), { message: 'User does not belong to any organisation', status: 403 });
});

test('validateSharedGroupsForOrg', async () => {
    fx.groups = [{ id: 'g1', organizationId: 'o' }, { id: 'g2', organizationId: 'o' }, { id: 'g3', organizationId: 'p' }];
    const v = perms.validateSharedGroupsForOrg;
    assert.equal(await v('o', undefined), undefined);
    assert.equal(await v('o', null), undefined);
    assert.deepEqual(await v('o', []), []);
    assert.deepEqual(await v('o', ['g1', 'g1', '', 'g2']), ['g1', 'g2']);
    await assert.rejects(v('o', 'g1'), { message: 'sharedGroups must be an array', status: 400 });
    await assert.rejects(v(null, ['g1']), { message: 'Cannot assign shared groups: resource has no organisation', status: 400 });
    await assert.rejects(v('o', ['g1', 'g3']), { message: 'Invalid groups for this organisation: g3', status: 400 });
    await assert.rejects(v('o', null, { requireNonEmpty: true }), { code: 'groups_required', status: 400, message: 'Pick at least one group to share this with' });
    await assert.rejects(v('o', [''], { requireNonEmpty: true }), { code: 'groups_required' });
});

// ── 8. Redis cache path + pub/sub fan-out ───────────────────────────────────
function makeFakeRedis() {
    const store = new Map();
    const ops = [];
    const handlers = {};
    const redis = {
        store, ops, handlers,
        async get(k) { ops.push(['get', k]); return store.has(k) ? store.get(k) : null; },
        async set(k, v, ...rest) { ops.push(['set', k, ...rest]); store.set(k, String(v)); return 'OK'; },
        async del(...keys) { ops.push(['del', ...keys]); keys.forEach((k) => store.delete(k)); return keys.length; },
        async unlink(...keys) { ops.push(['unlink', ...keys]); keys.forEach((k) => store.delete(k)); return keys.length; },
        async scan(cursor, ...args) { ops.push(['scan', cursor, ...args]); return ['0', [...store.keys()].filter((k) => k.startsWith('bf:perms:'))]; },
        async publish(ch, msg) { ops.push(['publish', ch, msg]); return 1; },
        duplicate() {
            ops.push(['duplicate']);
            return {
                on(ev, fn) { handlers[ev] = fn; },
                subscribe(...args) { const cb = args.pop(); ops.push(['subscribe', ...args]); cb(null); },
            };
        },
    };
    return redis;
}

test('Redis: stamped key + TTL, invalidation publishes, subscriber clears the local copy', async () => {
    const redis = makeFakeRedis();
    currentRedis = redis;
    fx.users.r = { id: 'r', role: 'user', groups: [] };
    assert.deepEqual(await perms.getUserPermissions('r'), ['page_chat']);
    const key = buildKey('bf:perms:r');
    assert.deepEqual(redis.ops, [['get', key], ['set', key, 'EX', 30]]);
    redis.ops.length = 0;
    calls.length = 0;
    assert.deepEqual(await perms.getUserPermissions('r'), ['page_chat']);
    assert.deepEqual(calls, [], 'served from Redis');

    redis.ops.length = 0;
    await perms.invalidatePermissionCache('r');
    assert.deepEqual(redis.ops, [
        ['del', key], ['duplicate'], ['subscribe', 'bf:perms:invalidate', 'bf:uex:invalidate'],
        ['publish', 'bf:perms:invalidate', 'r'],
    ]);

    redis.ops.length = 0;
    await perms.invalidateUserExistenceCache('r');
    assert.deepEqual(redis.ops, [['del', buildKey('bf:uex:r')], ['publish', 'bf:uex:invalidate', 'r']]);

    redis.store.set(buildKey('bf:perms:q'), '["x"]');
    redis.ops.length = 0;
    await perms.invalidateAllPermissionCaches();
    assert.deepEqual(redis.ops, [
        ['scan', '0', 'MATCH', 'bf:perms:*', 'COUNT', 200],
        ['unlink', buildKey('bf:perms:q')],
        ['publish', 'bf:perms:invalidate', '*'],
    ]);

    // A message from another node drops this node's in-memory copy.
    currentRedis = null;
    fx.roles = [{ id: 'user', permissions: ['use_forms'] }];
    assert.deepEqual(await perms.getUserPermissions('r'), ['use_forms', 'page_chat']);
    fx.roles = [];
    assert.deepEqual(await perms.getUserPermissions('r'), ['use_forms', 'page_chat'], 'cached locally');
    redis.handlers.message('bf:perms:invalidate', 'r');
    assert.deepEqual(await perms.getUserPermissions('r'), ['page_chat']);
    fx.roles = [{ id: 'user', permissions: ['use_apps'] }];
    redis.handlers.message('bf:perms:invalidate', '*');
    assert.deepEqual(await perms.getUserPermissions('r'), ['use_apps', 'page_chat']);
});

test('Redis: requireAuth reads and writes the stamped existence key', async () => {
    const redis = makeFakeRedis();
    currentRedis = redis;
    fx.users.ex = { id: 'ex', role: 'user' };
    const r = await run(perms.requireAuth, { session: session({ id: 'ex' }) });
    assert.equal(r.status, 'next');
    const key = buildKey('bf:uex:ex');
    assert.deepEqual(redis.ops.slice(0, 2), [['get', key], ['set', key, 'EX', 5]]);
    redis.ops.length = 0;
    const gone = await run(perms.requireAuth, { session: session({ id: 'ex2' }) });
    assert.equal(gone.status, 401);
    assert.deepEqual(redis.ops, [['get', buildKey('bf:uex:ex2')], ['set', buildKey('bf:uex:ex2'), 'EX', 5], ['del', buildKey('bf:uex:ex2')]]);
    await tick(); await tick();
});
