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
    groupReads: [],       // every group lookup: an id, or 'all' for the whole table
    updated: [],
    shared: [],
    activity: [],
    unassigned: [],
    listed: [],           // every listUserProjects call, with its options
    kindSet: [],          // every setProjectKind call
    assigned: [],         // every assignConversation call
    vanishOnUpdate: false,
};

const MOCKS = {
    '../stores/projectStore': {
        getProject: async (id) => fx.projects[id] || null,
        listUserProjects: async (userId, groupIds, opts) => {
            fx.listed.push({ userId, opts: opts ?? null });
            const kind = opts?.kind;
            return Object.values(fx.projects).filter(p => !kind || p.kind === kind || p.kind == null);
        },
        createProject: async (p) => { const row = { id: 'new', ...p }; fx.projects.new = row; return row; },
        updateProject: async (id, u) => {
            fx.updated.push({ id, ...u });
            if (fx.vanishOnUpdate) return null;
            return { ...fx.projects[id], ...u };
        },
        setProjectKind: async (id, kind) => {
            fx.kindSet.push({ id, kind });
            const p = fx.projects[id];
            if (!p || p.kind) return null;
            p.kind = kind;
            return { ...p };
        },
        deleteProject: async () => true,
        shareProject: async (projectId, type, id, perm) => { fx.shared.push({ projectId, type, id, perm }); return 'share1'; },
        getProjectShares: async () => fx.shares,
        getShareById: async (id) => fx.shares.find(s => s.id === id) || null,
        updateMemberRole: async () => true,
        unshareProject: async () => true,
        unassignConversation: async (convId, userId) => { fx.unassigned.push({ convId, userId }); return true; },
        // Bob's own chat c1, filed but not shared; anybody else's reads as none.
        getOwnConversationFiling: async (convId, userId) => (convId === 'c1' && userId === 'bob' ? { projectId: 'p1', shared: false } : null),
        assignConversation: async (convId, projectId, userId) => { fx.assigned.push({ convId, projectId, userId }); return true; },
        // The audit row and its live event, one transaction (projects/changeFeed).
        recordActivityEvent: async (projectId, entry) => { fx.activity.push({ projectId, actorId: entry.actorId, action: entry.action }); return null; },
        listActivity: async () => [],
        normalizePermission: (p) => (p === 'edit' ? 'editor' : p === 'view' ? 'viewer' : p),
    },
    '../stores/userStore': {
        getUser: async (id) => fx.users[id] || null,
        getAllGroups: async () => { fx.groupReads.push('all'); return fx.groups; },
        getGroup: async (id) => { fx.groupReads.push(id); return fx.groups.find(g => g.id === id) || null; },
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
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

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
    fx.listed.length = 0;
    fx.kindSet.length = 0;
    fx.groupReads.length = 0;
    fx.assigned.length = 0;
    fx.vanishOnUpdate = false;
}

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const query = Object.fromEntries(new URLSearchParams(qs));
        const req = { method, url, body, headers: {}, session, query, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            set(h) { this.headers = { ...this.headers, ...h }; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            // A thrown HttpError (or a schema refusal) answers the way the app does.
            return terminalErrorHandler(err, req, res, () => reject(err));
        });
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


// ═══ Workspace or Solution ═══════════════════════════════════════════

const CAROL = { user: { id: 'carol', organizationId: 'org1' } };

test('the list narrows by kind when asked, and lists everything when not', async () => {
    resetFx();
    fx.projects = {
        w: { id: 'w', kind: 'workspace', ownerId: 'alice', organizationId: 'org1' },
        s: { id: 's', kind: 'solution', ownerId: 'alice', organizationId: 'org1' },
        l: { id: 'l', kind: null, ownerId: 'alice', organizationId: 'org1' },
    };
    const ws = await dispatch({ method: 'GET', url: '/?kind=workspace', session: ALICE });
    assert.strictEqual(ws.statusCode, 200);
    assert.deepStrictEqual(fx.listed.at(-1), { userId: 'alice', opts: { kind: 'workspace' } });
    assert.deepStrictEqual(ws.body.map(p => p.id).sort(), ['l', 'w']);

    const all = await dispatch({ method: 'GET', url: '/', session: ALICE });
    assert.deepStrictEqual(fx.listed.at(-1).opts, { kind: undefined }, 'no kind: the store lists every kind');
    assert.strictEqual(all.body.length, 3);
});

test('an unknown kind on the list is refused before the store', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/?kind=folder', session: ALICE });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /kind is workspace/);
    assert.deepStrictEqual(fx.listed, []);
});

test('a new project is a workspace unless it asks to be a Solution', async () => {
    resetFx();
    const plain = await dispatch({ method: 'POST', url: '/', body: { name: 'Team' }, session: ALICE });
    assert.strictEqual(plain.statusCode, 200);
    assert.strictEqual(plain.body.kind, 'workspace');

    const sol = await dispatch({ method: 'POST', url: '/', body: { name: 'Invoicing', kind: 'solution' }, session: ALICE });
    assert.strictEqual(sol.body.kind, 'solution');

    const bad = await dispatch({ method: 'POST', url: '/', body: { name: 'X', kind: 'folder' }, session: ALICE });
    assert.strictEqual(bad.statusCode, 400);
});

// Classifying itself (once, the backfill's guess corrected once, refused
// while the project holds what the other side cannot hold) is proven in
// routes/projects/kind.test.js and, through the real registry, in
// routes/projects.resources.test.js. Here: the gate and the schema as
// routes/projects.js mounts it.

test('only the owner classifies: an editor gets 403, a stranger 404', async () => {
    resetFx();
    fx.projects.p1.kind = null;
    fx.role = 'editor';
    assert.strictEqual((await dispatch({ method: 'PUT', url: '/p1/kind', body: { kind: 'solution' }, session: BOB })).statusCode, 403);
    fx.role = null;
    assert.strictEqual((await dispatch({ method: 'PUT', url: '/p1/kind', body: { kind: 'solution' }, session: BOB })).statusCode, 404);
    assert.deepStrictEqual(fx.kindSet, [], 'the store was never asked');
    assert.strictEqual(fx.projects.p1.kind, null);
});

test('classifying needs a real kind, and a project that is gone is a 404', async () => {
    resetFx();
    const bad = await dispatch({ method: 'PUT', url: '/p1/kind', body: { kind: 'folder' }, session: ALICE });
    assert.strictEqual(bad.statusCode, 400);
    const missing = await dispatch({ method: 'PUT', url: '/p1/kind', body: {}, session: ALICE });
    assert.strictEqual(missing.statusCode, 400);
    assert.deepStrictEqual(fx.kindSet, []);

    delete fx.projects.p1;
    const gone = await dispatch({ method: 'PUT', url: '/p1/kind', body: { kind: 'workspace' }, session: ALICE });
    assert.strictEqual(gone.statusCode, 404);
});

test('a project deleted while it was being edited is a 404, not a 500', async () => {
    resetFx();
    fx.vanishOnUpdate = true;
    const res = await dispatch({ method: 'PUT', url: '/p1', body: { name: 'Renamed' }, session: ALICE });
    assert.strictEqual(res.statusCode, 404);
});

// ── Members, with names ──────────────────────────────────────────────

test('members come with names for the owner and the members of the project\'s organisation', async () => {
    resetFx();
    fx.role = 'viewer';
    fx.users = {
        alice: { id: 'alice', displayName: 'Alice A', username: 'alice', email: 'alice@example.test', organizationId: 'org1', passwordHash: 'x' },
        bob: { id: 'bob', firstName: 'Bob', lastName: 'B', username: 'bob', email: 'bob@example.test', organizationId: 'org1', wrappedDEK: 'k' },
        mallory: { id: 'mallory', displayName: 'Mallory', email: 'mallory@elsewhere.test', organizationId: 'org2' },
    };
    fx.groups = [
        { id: 'g-sales', name: 'Sales', organizationId: 'org1' },
        { id: 'g-other', name: 'Their team', organizationId: 'org2' },
    ];
    fx.shares = [
        { id: 's1', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'bob', permission: 'editor' },
        // A cross-tenant row the share route would refuse today; older data may carry one.
        { id: 's2', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'mallory', permission: 'viewer' },
        { id: 's3', projectId: 'p1', sharedWithType: 'group', sharedWithId: 'g-sales', permission: 'viewer' },
        { id: 's4', projectId: 'p1', sharedWithType: 'group', sharedWithId: 'g-other', permission: 'viewer' },
        { id: 's5', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'ghost', permission: 'viewer' },
    ];

    const res = await dispatch({ method: 'GET', url: '/p1/members', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ownerId, 'alice');
    assert.strictEqual(res.body.members.length, 5);
    assert.deepStrictEqual(res.body.people, {
        alice: { name: 'Alice A' },
        bob: { name: 'Bob B' },
    });
    assert.deepStrictEqual(res.body.groups, { 'g-sales': { name: 'Sales' } });
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('mallory@') && !text.includes('Their team'), 'nothing of another tenant is named');
    assert.ok(!/passwordHash|wrappedDEK/.test(text), 'a user is an allow-listed name, never the row');
});

test('a viewer never gets the members\' e-mail addresses, only names', async () => {
    // The member list is readable by any viewer; the organisation's directory
    // gives a non-admin no addresses, and neither may this list.
    resetFx();
    fx.role = 'viewer';
    fx.users = {
        alice: { id: 'alice', displayName: 'Alice A', email: 'alice@example.test', organizationId: 'org1' },
        bob: { id: 'bob', email: 'bob@example.test', organizationId: 'org1' },
    };
    fx.shares = [{ id: 's1', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'bob', permission: 'viewer' }];
    const res = await dispatch({ method: 'GET', url: '/p1/members', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.doesNotMatch(JSON.stringify(res.body), /@example\.test|"email"/);
    assert.deepStrictEqual(res.body.people, { alice: { name: 'Alice A' }, bob: {} }, 'a person without a name stays unnamed');
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('a member\'s own avatar: an emoji, a path or a url inline; an uploaded picture as a link to the avatar route, not inline', async () => {
    resetFx();
    fx.role = 'viewer';
    fx.users = {
        alice: { id: 'alice', displayName: 'Alice A', organizationId: 'org1', avatar: PNG, avatarType: 'image' },
        bob: { id: 'bob', displayName: 'Bob B', organizationId: 'org1', avatar: '🦊', avatarType: 'emoji' },
        cy: { id: 'cy', displayName: 'Cy C', organizationId: 'org1', avatar: '/uploads/avatars/cy.png', avatarType: 'image' },
        di: { id: 'di', displayName: 'Di D', organizationId: 'org1', avatar: 'https://nc.example.test/avatar/di/64', avatarType: 'url' },
        ed: { id: 'ed', displayName: 'Ed E', organizationId: 'org1', avatar: 'x'.repeat(5000), avatarType: 'url' },
        fay: { id: 'fay', displayName: 'Fay F', organizationId: 'org1', avatar: '🦊', avatarType: 'bogus' },
    };
    fx.shares = ['bob', 'cy', 'di', 'ed', 'fay'].map((id, i) => ({ id: `s${i}`, projectId: 'p1', sharedWithType: 'user', sharedWithId: id, permission: 'viewer' }));
    const { people } = (await dispatch({ method: 'GET', url: '/p1/members', session: BOB })).body;
    assert.match(people.alice.avatar, /^\/api\/projects\/p1\/avatars\/alice\?v=[0-9a-f]{10}$/);
    assert.strictEqual(people.alice.avatarType, 'image');
    assert.deepStrictEqual(people.bob, { name: 'Bob B', avatar: '🦊', avatarType: 'emoji' });
    assert.deepStrictEqual(people.cy, { name: 'Cy C', avatar: '/uploads/avatars/cy.png', avatarType: 'image' });
    assert.strictEqual(people.di.avatar, 'https://nc.example.test/avatar/di/64');
    assert.deepStrictEqual(people.ed, { name: 'Ed E' }, 'something huge that is not a picture stays out');
    assert.deepStrictEqual(people.fay, { name: 'Fay F' }, 'an unknown type stays out');
    assert.ok(!JSON.stringify(people).includes('iVBORw0KGgo'), 'the picture itself is not in the list');
});

test('the avatar route serves the picture as an image to members, only for people of the project and only raster types', async () => {
    resetFx();
    fx.role = 'viewer';
    fx.users = {
        alice: { id: 'alice', organizationId: 'org1', avatar: PNG, avatarType: 'image' },
        bob: { id: 'bob', organizationId: 'org1', avatar: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', avatarType: 'image' },
        cy: { id: 'cy', organizationId: 'org1', avatar: PNG, avatarType: 'image' },
        mallory: { id: 'mallory', organizationId: 'org2', avatar: PNG, avatarType: 'image' },
    };
    fx.shares = [
        { id: 's1', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'bob', permission: 'viewer' },
        { id: 's2', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'mallory', permission: 'viewer' },
    ];
    const ok = await dispatch({ method: 'GET', url: '/p1/avatars/alice', session: BOB });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.headers['Content-Type'], 'image/png');
    assert.strictEqual(ok.headers['X-Content-Type-Options'], 'nosniff');
    assert.ok(Buffer.isBuffer(ok.body) && ok.body.length > 0);
    for (const who of ['bob', 'cy', 'mallory', 'nobody']) {
        assert.strictEqual((await dispatch({ method: 'GET', url: `/p1/avatars/${who}`, session: BOB })).statusCode, 404, who);
    }
});

test('member groups are read one by one, never as the whole groups table', async () => {
    resetFx();
    fx.role = 'viewer';
    // Many groups on the install, two of them on this project.
    fx.groups = Array.from({ length: 50 }, (_, i) => ({ id: `g${i}`, name: `Group ${i}`, organizationId: 'org1' }));
    fx.shares = [
        { id: 's1', projectId: 'p1', sharedWithType: 'group', sharedWithId: 'g3', permission: 'viewer' },
        { id: 's2', projectId: 'p1', sharedWithType: 'group', sharedWithId: 'g7', permission: 'editor' },
        { id: 's3', projectId: 'p1', sharedWithType: 'group', sharedWithId: 'g-gone', permission: 'viewer' },
    ];
    const res = await dispatch({ method: 'GET', url: '/p1/members', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.groups, { g3: { name: 'Group 3' }, g7: { name: 'Group 7' } });
    assert.deepStrictEqual([...fx.groupReads].sort(), ['g-gone', 'g3', 'g7'], 'only the groups the project names');
    assert.ok(!fx.groupReads.includes('all'), 'the whole groups table is never read');

    // Without a group share there is no group lookup at all.
    fx.groupReads.length = 0;
    fx.shares = [{ id: 's1', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'bob', permission: 'viewer' }];
    await dispatch({ method: 'GET', url: '/p1/members', session: BOB });
    assert.deepStrictEqual(fx.groupReads, []);
});

test('an org-less project names org-less people only', async () => {
    resetFx();
    fx.projects.p1.organizationId = '';
    fx.users = {
        alice: { id: 'alice', username: 'alice', organizationId: '' },
        bob: { id: 'bob', username: 'bob', organizationId: 'org1' },
    };
    fx.shares = [{ id: 's1', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'bob', permission: 'viewer' }];
    const res = await dispatch({ method: 'GET', url: '/p1/members', session: ALICE });
    assert.deepStrictEqual(res.body.people, { alice: { name: 'alice' } });
});

test('a stranger learns nothing about the members', async () => {
    resetFx();
    fx.role = null;
    fx.users = { alice: { id: 'alice', displayName: 'Alice', organizationId: 'org1' } };
    const res = await dispatch({ method: 'GET', url: '/p1/members', session: CAROL });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!('people' in (res.body || {})));
});

// ── Chats are never filed into a Solution ────────────────────────────

test('a conversation cannot be shared into a Solution', async () => {
    resetFx();
    fx.projects.p1.kind = 'solution';
    fx.role = 'editor';
    const res = await dispatch({ method: 'POST', url: '/p1/threads', body: { conversationId: 'c1' }, session: BOB });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'SOLUTION_HOLDS_NO_CHATS');
    assert.ok(!fx.activity.some(a => a.action === 'thread_shared'));
});

test('conversations cannot be filed into a Solution, but may be taken out of one', async () => {
    resetFx();
    fx.projects.p1.kind = 'solution';
    fx.role = 'editor';
    const filing = await dispatch({
        method: 'PUT', url: '/p1/conversations',
        body: { assign: [{ id: 'c1', type: 'direct' }] }, session: BOB,
    });
    assert.strictEqual(filing.statusCode, 409);
    assert.strictEqual(filing.body.code, 'SOLUTION_HOLDS_NO_CHATS');
    assert.deepStrictEqual(fx.assigned, [], 'nothing was filed');

    const out = await dispatch({
        method: 'PUT', url: '/p1/conversations',
        body: { unassign: [{ id: 'c1', type: 'direct' }] }, session: BOB,
    });
    assert.strictEqual(out.statusCode, 200);
    assert.deepStrictEqual(fx.unassigned, [{ convId: 'c1', userId: 'bob' }]);
});

test('conversations still file into a workspace and into a legacy project', async () => {
    for (const kind of ['workspace', null]) {
        resetFx();
        fx.projects.p1.kind = kind;
        fx.role = 'editor';
        const res = await dispatch({
            method: 'PUT', url: '/p1/conversations',
            body: { assign: [{ id: 'c1', type: 'direct' }] }, session: BOB,
        });
        assert.strictEqual(res.statusCode, 200, `kind ${kind}`);
        assert.deepStrictEqual(fx.assigned, [{ convId: 'c1', projectId: 'p1', userId: 'bob' }]);
    }
});

test('GET /:id says which kind the project is', async () => {
    resetFx();
    fx.projects.p1.kind = 'workspace';
    fx.projects.p1.filesKbId = null;
    const res = await dispatch({ method: 'GET', url: '/p1', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.kind, 'workspace');
    assert.ok('filesKbId' in res.body);
});
