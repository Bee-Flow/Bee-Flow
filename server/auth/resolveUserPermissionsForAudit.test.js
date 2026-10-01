/**
 * The session-elevation trap, pinned.
 *
 * getUserPermissions(userId, session) returns ['all'] whenever session.isAdmin —
 * regardless of userId. That is correct for "may I?" and catastrophic for
 * "may THEY?": an Access Map built the naive way would paint every user's
 * permissions fully green the moment a super-admin opened it, and look right.
 * Nobody would notice, because a screen that says "yes to everything" for an
 * admin's own view is exactly what you'd expect to see.
 *
 * resolveUserPermissionsForAudit(userId) has no session parameter at all, so the
 * elevation is unreachable by construction. These tests assert that property
 * rather than trusting a comment.
 *
 * Run: cd server && node --test auth/resolveUserPermissionsForAudit.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');

// ── Stub the store so this is a pure unit test (no DB, no Redis) ─────
const fx = { users: {}, groups: [], roles: [] };

const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => fx.users[id] || null,
        getAllGroups: async () => fx.groups,
        getAllRoles: async () => fx.roles,
    },
    '../db': { getRedis: () => null },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:perm-audit:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]permissions\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const permissions = require(path.join(SERVER, 'auth', 'permissions.js'));
Module._resolveFilename = originalResolve;

const { getUserPermissions, resolveUserPermissionsForAudit, invalidatePermissionCache } = permissions;

function seed() {
    fx.users = {
        // A deliberately low-privilege target.
        member: { id: 'member', role: 'user', orgRole: 'member', groups: [], organizationId: 'orgA' },
        // A super-admin target: must resolve to ['all'] on their OWN merit.
        root: { id: 'root', role: 'admin', orgRole: null, groups: [], organizationId: null },
    };
    fx.groups = [];
    fx.roles = [];
    for (const id of Object.keys(fx.users)) {
        try { invalidatePermissionCache(id); } catch (_) { /* best effort */ }
    }
}

// The caller in every test below is an admin — the exact situation that triggers
// the trap.
const ADMIN_SESSION = { isAdmin: true, isAuthenticated: true, user: { id: 'root', role: 'admin' } };

describe('the trap is real (characterising the existing function)', () => {
    test('getUserPermissions reports ["all"] for a low-priv user when the CALLER is admin', async () => {
        seed();
        const perms = await getUserPermissions('member', ADMIN_SESSION);
        assert.deepEqual(perms, ['all'], 'this is the documented behaviour that makes the naive Access Map lie');
    });
});

describe('resolveUserPermissionsForAudit', () => {
    test('reports the TARGET\'s real permissions even while an admin is asking', async () => {
        seed();
        // The whole point: an admin session is in scope, and it changes nothing.
        const perms = await resolveUserPermissionsForAudit('member');
        assert.ok(!perms.includes('all'), `a member must not resolve to 'all', got ${JSON.stringify(perms)}`);
    });

    test('takes exactly one argument — a session cannot be passed even by mistake', async () => {
        // The guarantee is structural. If someone later adds a session parameter
        // "for convenience", this fails and the reviewer has to think about why.
        assert.equal(resolveUserPermissionsForAudit.length, 1);
    });

    test('ignores a session even if one is forced in as a second argument', async () => {
        seed();
        const perms = await resolveUserPermissionsForAudit('member', ADMIN_SESSION);
        assert.ok(!perms.includes('all'), 'extra arguments must not reach getUserPermissions\' session slot');
    });

    test('a super-admin TARGET still resolves to ["all"] on their own merit', async () => {
        seed();
        // permissions.js:407 — user.role === 'admin' → ['all'], independent of any
        // session. Under-reporting a real admin would be its own kind of lie.
        const perms = await resolveUserPermissionsForAudit('root');
        assert.deepEqual(perms, ['all']);
    });

    test('a missing user resolves to the minimal fallback, not to elevation', async () => {
        seed();
        const perms = await resolveUserPermissionsForAudit('ghost');
        assert.deepEqual(perms, ['page_chat']);
        // NOTE for the Access Map: this is indistinguishable from a degraded
        // lookup (permissions.js:404 and :522 return the same array), so the UI
        // must render both as `unknown` rather than "almost no access" — an admin
        // who believes it will grant permissions that were never missing.
    });

    test('the two functions disagree exactly where the trap lives', async () => {
        seed();
        const naive = await getUserPermissions('member', ADMIN_SESSION);
        const safe = await resolveUserPermissionsForAudit('member');
        assert.notDeepEqual(naive, safe, 'if these ever agree, the trap defence has been removed');
    });
});

// A capability granted to a group can carry its UI permission along
// (GROUP_GRANT_IMPLIED_PERMISSIONS). Meeting Notes is rolled out per group from
// the Access matrix, and the default `member` role has no use_meeting_notes, so
// without this the members it was granted to never saw the Studio section.
describe('a group capability grant implies its UI permission', () => {
    function seedGroups() {
        fx.users = {
            scribe: { id: 'scribe', role: 'user', orgRole: 'member', groups: ['g-meet'], organizationId: 'orgA' },
            bystander: { id: 'bystander', role: 'user', orgRole: 'member', groups: ['g-other'], organizationId: 'orgA' },
        };
        fx.groups = [
            { id: 'g-meet', organizationId: 'orgA', granted_capabilities: ['meeting_notes'] },
            { id: 'g-other', organizationId: 'orgA', granted_capabilities: ['gmail'] },
        ];
        fx.roles = [];
        for (const id of Object.keys(fx.users)) {
            try { invalidatePermissionCache(id); } catch (_) { /* best effort */ }
        }
    }

    test('the map names meeting_notes → use_meeting_notes', () => {
        assert.deepEqual([...permissions.GROUP_GRANT_IMPLIED_PERMISSIONS.meeting_notes], ['use_meeting_notes']);
    });

    test('a member of a group granted meeting_notes holds use_meeting_notes', async () => {
        seedGroups();
        const perms = await resolveUserPermissionsForAudit('scribe');
        assert.ok(perms.includes('use_meeting_notes'), `got ${JSON.stringify(perms)}`);
    });

    test('a member whose groups grant something else does not', async () => {
        seedGroups();
        const perms = await resolveUserPermissionsForAudit('bystander');
        assert.ok(!perms.includes('use_meeting_notes'), `got ${JSON.stringify(perms)}`);
    });
});
