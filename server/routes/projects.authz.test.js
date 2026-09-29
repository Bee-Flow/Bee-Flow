/**
 * Projects-route authorization.
 *
 * The role ladder itself is tested in auth/projectAccess.test.js; this file
 * pins what the ROUTER does with it, plus the two guards that were wrong:
 *
 *   - KB LINKING BYPASSED THE KB ACCESS MODEL. validateKnowledgeBaseIds checked
 *     only "the row exists" plus a string compare on organization_id. That let
 *     through another member's unpublished draft, a shared_groups-restricted KB
 *     the linker isn't in, and — because projects.organization_id defaults to ''
 *     rather than NULL — literally any KB id whenever either org id was empty.
 *     Linking is a read grant: chat time searches a project's KBs with no
 *     further check.
 *
 *   - THE CROSS-ORG SHARE GUARD WAS CONDITIONAL ON BOTH ORG IDS BEING TRUTHY,
 *     so it never ran for an org-less project and the owner could share with
 *     any principal in any tenant.
 *
 * Run: cd server && node --test routes/projects.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    role: null,
    projects: {},
    shares: [],
    kbs: {},             // id -> row
    deniedKbIds: [],     // what partitionAccessibleKBIds refuses
    users: {},
    groups: [],
    updated: [],
    shared: [],
    activity: [],
    unassigned: [],
};

const MOCKS = {
    '../stores/projectStore': {
        getProject: async (id) => fx.projects[id] || null,
        listUserProjects: async () => Object.values(fx.projects),
        createProject: async (p) => { const row = { id: 'new', ...p }; fx.projects.new = row; return row; },
        updateProject: async (id, u) => { fx.updated.push({ id, ...u }); return { ...fx.projects[id], ...u }; },
        deleteProject: async () => true,
        shareProject: async (projectId, type, id, perm) => { fx.shared.push({ projectId, type, id, perm }); return 'share1'; },
        getProjectShares: async () => fx.shares,
        getShareById: async (id) => fx.shares.find(s => s.id === id) || null,
        updateMemberRole: async () => true,
        unshareProject: async () => true,
        unassignConversation: async (convId, userId) => { fx.unassigned.push({ convId, userId }); return true; },
        assignConversation: async () => true,
        logActivity: async (projectId, actorId, action) => { fx.activity.push({ projectId, actorId, action }); },
        listActivity: async () => [],
        normalizePermission: (p) => (p === 'edit' ? 'editor' : p === 'view' ? 'viewer' : p),
    },
    '../stores/userStore': {
        getUser: async (id) => fx.users[id] || null,
        getAllGroups: async () => fx.groups,
    },
    '../stores/knowledgeBases': {
        getKB: async (id) => fx.kbs[id] || null,
    },
    '../support/kbAccess': {
        partitionAccessibleKBIds: async (req, ids) => ({
            allowed: ids.filter(i => !fx.deniedKbIds.includes(i)),
            denied: ids.filter(i => fx.deniedKbIds.includes(i)),
        }),
    },
    '../auth': { resolveUserGroups: async () => [] },
    '../auth/projectAccess': {
        requireProjectRole: (minRole) => async (req, res, next) => {
            const order = { viewer: 0, editor: 1, owner: 2 };
            if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
            if (!fx.role) return res.status(404).json({ error: 'Not found' });
            if (order[fx.role] < order[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
            req.projectRole = fx.role;
            next();
        },
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:projects-authz:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // knowledgeBaseMembership.js holds validateKnowledgeBaseIds, which the two
    // project routes below call. Its own store requires must reach the doubles
    // too — otherwise the real store throws without a database, the catch
    // inside the validator counts every id as invalid, and a test named
    // "linking a readable KB succeeds" starts failing for a reason that has
    // nothing to do with access.
    if (parent && /(routes[\\/]projects|projects[\\/]knowledgeBaseMembership)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./projects');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.role = 'owner';
    fx.projects = { p1: { id: 'p1', name: 'P1', ownerId: 'alice', organizationId: 'org1', knowledgeBaseIds: [] } };
    fx.shares = [];
    fx.kbs = {};
    fx.deniedKbIds = [];
    fx.users = {};
    fx.groups = [];
    fx.updated.length = 0;
    fx.shared.length = 0;
    fx.activity.length = 0;
    fx.unassigned.length = 0;
}

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const query = Object.fromEntries(new URLSearchParams(qs));
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

const ALICE = { user: { id: 'alice', organizationId: 'org1' } };
const BOB = { user: { id: 'bob', organizationId: 'org1' } };

// ═══ The role ladder, per route ══════════════════════════════════════

test('viewer may read but not update', async () => {
    resetFx();
    fx.role = 'viewer';
    assert.strictEqual((await dispatch({ method: 'GET', url: '/p1', session: BOB })).statusCode, 200);
    assert.strictEqual((await dispatch({ method: 'PUT', url: '/p1', body: { name: 'x' }, session: BOB })).statusCode, 403);
    assert.deepStrictEqual(fx.updated, []);
});

test('editor may update but not delete or invite', async () => {
    resetFx();
    fx.role = 'editor';
    assert.strictEqual((await dispatch({ method: 'PUT', url: '/p1', body: { name: 'x' }, session: BOB })).statusCode, 200);
    assert.strictEqual((await dispatch({ method: 'DELETE', url: '/p1', session: BOB })).statusCode, 403);
    assert.strictEqual((await dispatch({
        method: 'POST', url: '/p1/share',
        body: { sharedWithType: 'user', sharedWithId: 'carol' }, session: BOB,
    })).statusCode, 403);
    assert.deepStrictEqual(fx.shared, []);
});

test('a non-member gets 404, never 403 — project existence is not probeable', async () => {
    resetFx();
    fx.role = null;
    for (const [method, url] of [['GET', '/p1'], ['PUT', '/p1'], ['DELETE', '/p1']]) {
        assert.strictEqual((await dispatch({ method, url, session: BOB })).statusCode, 404, `${method} ${url}`);
    }
});

// ═══ Regression: KB linking must honour KB read access ═══════════════

test('linking a KB the user cannot read is rejected', async () => {
    resetFx();
    fx.kbs.kbSecret = { id: 'kbSecret', organization_id: 'org1', is_published: false };
    fx.deniedKbIds = ['kbSecret'];

    const res = await dispatch({ method: 'PUT', url: '/p1', body: { knowledgeBaseIds: ['kbSecret'] }, session: ALICE });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body.invalid, ['kbSecret']);
    assert.deepStrictEqual(fx.updated, [], 'nothing persisted');
});

test('linking a readable, same-org KB succeeds', async () => {
    resetFx();
    fx.kbs.kbOk = { id: 'kbOk', organization_id: 'org1', is_published: true };

    const res = await dispatch({ method: 'PUT', url: '/p1', body: { knowledgeBaseIds: ['kbOk'] }, session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.updated.length, 1);
});

test('a readable KB from another org is still rejected', async () => {
    resetFx();
    fx.kbs.kbForeign = { id: 'kbForeign', organization_id: 'org2', is_published: true };

    const res = await dispatch({ method: 'PUT', url: '/p1', body: { knowledgeBaseIds: ['kbForeign'] }, session: ALICE });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body.invalid, ['kbForeign']);
});

test('an org-less project does not accept an org-owned KB', async () => {
    resetFx();
    // organization_id defaults to '' — the old guard skipped entirely here.
    fx.projects.p1.organizationId = '';
    fx.kbs.kbOrg = { id: 'kbOrg', organization_id: 'org1', is_published: true };

    const res = await dispatch({ method: 'PUT', url: '/p1', body: { knowledgeBaseIds: ['kbOrg'] }, session: ALICE });
    assert.strictEqual(res.statusCode, 400, 'empty org must not mean "matches everything"');
});

test('an unknown KB id is rejected', async () => {
    resetFx();
    fx.deniedKbIds = ['ghost'];

    const res = await dispatch({ method: 'PUT', url: '/p1', body: { knowledgeBaseIds: ['ghost'] }, session: ALICE });
    assert.strictEqual(res.statusCode, 400);
});

test('an oversized KB array is rejected before any lookup', async () => {
    resetFx();
    const many = Array.from({ length: 500 }, (_, i) => `kb${i}`);

    const res = await dispatch({ method: 'PUT', url: '/p1', body: { knowledgeBaseIds: many }, session: ALICE });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /At most/);
});

// ═══ Regression: cross-org share guard ═══════════════════════════════

test('sharing with a user from another org is rejected', async () => {
    resetFx();
    fx.users.carol = { id: 'carol', organizationId: 'org2' };

    const res = await dispatch({
        method: 'POST', url: '/p1/share',
        body: { sharedWithType: 'user', sharedWithId: 'carol', permission: 'viewer' }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.shared, []);
});

test('sharing an ORG-LESS project with an org user is rejected', async () => {
    resetFx();
    fx.projects.p1.organizationId = '';       // the case the old guard skipped
    fx.users.carol = { id: 'carol', organizationId: 'org2' };

    const res = await dispatch({
        method: 'POST', url: '/p1/share',
        body: { sharedWithType: 'user', sharedWithId: 'carol' }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.shared, [], 'an org-less project is not a wildcard');
});

test('sharing an org project with an ORG-LESS user is rejected', async () => {
    resetFx();
    fx.users.drifter = { id: 'drifter', organizationId: '' };

    const res = await dispatch({
        method: 'POST', url: '/p1/share',
        body: { sharedWithType: 'user', sharedWithId: 'drifter' }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.shared, []);
});

test('sharing with a same-org user succeeds', async () => {
    resetFx();
    fx.users.carol = { id: 'carol', organizationId: 'org1' };

    const res = await dispatch({
        method: 'POST', url: '/p1/share',
        body: { sharedWithType: 'user', sharedWithId: 'carol', permission: 'editor' }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.shared.length, 1);
    assert.strictEqual(fx.shared[0].perm, 'editor');
});

test('sharing with a group from another org is rejected', async () => {
    resetFx();
    fx.groups = [{ id: 'eng', organizationId: 'org2' }];

    const res = await dispatch({
        method: 'POST', url: '/p1/share',
        body: { sharedWithType: 'group', sharedWithId: 'eng' }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.shared, []);
});

test('an unknown principal is rejected', async () => {
    resetFx();
    const user = await dispatch({
        method: 'POST', url: '/p1/share',
        body: { sharedWithType: 'user', sharedWithId: 'nobody' }, session: ALICE,
    });
    const group = await dispatch({
        method: 'POST', url: '/p1/share',
        body: { sharedWithType: 'group', sharedWithId: 'nogroup' }, session: ALICE,
    });
    assert.strictEqual(user.statusCode, 400);
    assert.strictEqual(group.statusCode, 400);
});

// ═══ IDOR guards on share ids ════════════════════════════════════════

test('an owner cannot delete a share belonging to a different project', async () => {
    resetFx();
    fx.shares = [{ id: 's-other', projectId: 'p2', sharedWithType: 'user', sharedWithId: 'x' }];

    const res = await dispatch({ method: 'DELETE', url: '/p1/share/s-other', session: ALICE });
    assert.strictEqual(res.statusCode, 404);
});

test('an owner cannot change the role of a share on a different project', async () => {
    resetFx();
    fx.shares = [{ id: 's-other', projectId: 'p2', sharedWithType: 'user', sharedWithId: 'x', permission: 'viewer' }];

    const res = await dispatch({ method: 'PUT', url: '/p1/members/s-other', body: { role: 'editor' }, session: ALICE });
    assert.strictEqual(res.statusCode, 404);
});

// ═══ Self-leave and self-detach ══════════════════════════════════════

test('a member may remove their own membership', async () => {
    resetFx();
    fx.role = 'viewer';
    fx.shares = [{ id: 's1', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'bob' }];

    const res = await dispatch({ method: 'DELETE', url: '/p1/members/s1', session: BOB });
    assert.strictEqual(res.statusCode, 200);
});

test('a member may NOT remove someone else', async () => {
    resetFx();
    fx.role = 'viewer';
    fx.shares = [{ id: 's2', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'carol' }];

    const res = await dispatch({ method: 'DELETE', url: '/p1/members/s2', session: BOB });
    assert.strictEqual(res.statusCode, 403);
});

test('anyone may detach their OWN conversation without a project role', async () => {
    resetFx();
    fx.role = null;                 // not a member of anything

    const res = await dispatch({ method: 'DELETE', url: '/conversations/c1', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    // The store filters on user_id, so this can only ever touch Bob's own row.
    assert.deepStrictEqual(fx.unassigned, [{ convId: 'c1', userId: 'bob' }]);
});

// ═══ Bulk caps ═══════════════════════════════════════════════════════

test('an oversized conversation batch is rejected', async () => {
    resetFx();
    fx.role = 'editor';
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, type: 'direct' }));

    const res = await dispatch({ method: 'PUT', url: '/p1/conversations', body: { assign: many }, session: ALICE });
    assert.strictEqual(res.statusCode, 400);
});

// ═══ Error bodies do not leak internals ══════════════════════════════

test('a store failure returns a generic message, not the DB error', async () => {
    resetFx();
    const original = MOCKS['../stores/projectStore'].listUserProjects;
    MOCKS['../stores/projectStore'].listUserProjects = async () => {
        throw new Error('relation "projects" does not exist at character 15');
    };
    try {
        const res = await dispatch({ method: 'GET', url: '/', session: ALICE });
        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body.error, 'Request failed');
        assert.ok(!/relation|character/.test(JSON.stringify(res.body)), 'no SQL text in the response');
    } finally {
        MOCKS['../stores/projectStore'].listUserProjects = original;
    }
});
