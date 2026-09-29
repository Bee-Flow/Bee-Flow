/**
 * routes/memory.js authorization — classification plus the project-memory
 * regression suite.
 *
 * A. CLASSIFICATION. This router is AUTHENTICATED: `router.use(requireAuth)`
 *    401s an anonymous or guest-cookie caller before any handler runs (see the
 *    SECURITY header in memory.js). It was classified as a deliberate guest
 *    path on 2026-09-05 (U4b, dossier 4a) because the guest-chat runtime
 *    remembered things under the visitor's guest-cookie id; the 2026-08 memory
 *    overhaul removed that premise — the extractor writes nothing for a
 *    `guest_*` id (agents/memory/extractor.guest.test.js) and the rows written
 *    before were purged (migrations/memory-guest-purge-2026-08.js) — so what
 *    was left of the open design was an unauthenticated write path into the
 *    system prompt of later turns (routes/memory.guards.test.js). Pinned here:
 *
 *      1. Anonymous and guest-cookie callers get 401 everywhere — a guest
 *         cookie is NOT authentication.
 *      2. The scoping that was always the safety of this router — every route
 *         answers only about the effective user's own rows, and per-row access
 *         refuses rows owned by someone else (canAccessMemory) — still holds
 *         between signed-in users.
 *      3. POST /import invokes an LLM: 401 before any model call.
 *
 * B. REGRESSIONS. Project memories are a shared pool by design — memoryStore
 *    drops its `user_id` filter whenever a projectId is present, so the role
 *    check is the only thing standing between a viewer and the delete button.
 *    That check has been wrong twice (see canAccessMemory in memory.js): it
 *    used `userHasAccess`, which is true for viewers, letting a read-only
 *    member wipe a project's entire memory; and GET /?projectId= skipped
 *    membership entirely, letting any logged-in user dump project memories by
 *    guessing the UUID. The regression section pins both fixes — reads ask
 *    for 'viewer', writes for 'editor', listing needs membership — plus the
 *    404-for-missing-rows behavior.
 *
 * Run: cd server && node --test --test-force-exit routes/memory.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    rows: {},            // id -> memory row
    projectRole: false,  // caller's role in any project: false | 'viewer' | 'editor' | 'owner'
    roleCalls: [],       // hasProjectRole spy: { userId, projectId, minRole }
    listCalls: [],       // searchUserMemories: userId per call
    createCalls: [],     // createMemory args
    updateCalls: [],     // updateMemory: { id, content }
    deleteCalls: [],
    clearCalls: [],      // { what: 'personal', userId } | { what: 'project', projectId }
    llmCalls: 0,
};

const MOCKS = {
    '../stores/memoryStore': {
        searchUserMemories: async (userId, opts) => {
            fx.listCalls.push(userId);
            return { items: [], total: 0, limit: opts.limit, offset: opts.offset };
        },
        getMemoryById: async (id) => fx.rows[id] || null,
        createMemory: async (...args) => { fx.createCalls.push(args); return 'm-new'; },
        updateMemory: async (id, content) => { fx.updateCalls.push({ id, content }); },
        deleteMemory: async (id) => { fx.deleteCalls.push(id); },
        getMemories: async () => [],
        getMemoriesForProject: async () => [],
        getMemoriesForAgent: async () => [],
        getMemoryStats: async () => ({}),
        clearAllMemories: async (userId) => { fx.clearCalls.push({ what: 'personal', userId }); },
        clearProjectMemories: async (projectId) => { fx.clearCalls.push({ what: 'project', projectId }); },
        // Import de-dupes against existing rows (routes/memory.guards.test.js);
        // nothing similar exists in this suite.
        findSimilarMemory: async () => null,
        confirmMemory: async () => {},
    },
    '../auth/projectAccess': {
        // minRole-AWARE on purpose: canAccessMemory's whole reason to exist is
        // that reads ask for 'viewer' and writes for 'editor' (memory.js). A
        // mock that returns one verdict regardless of minRole cannot catch a
        // regression that lets writes ask for 'viewer' again.
        hasProjectRole: async (userId, projectId, minRole) => {
            fx.roleCalls.push({ userId, projectId, minRole });
            if (!fx.projectRole) return false;
            const order = { viewer: 0, editor: 1, owner: 2 };
            return order[fx.projectRole] >= order[minRole];
        },
    },
    '../auth': {
        // Mirrors the decision line of the real requireAuth
        // (auth/permissions.js) — a guest cookie is NOT authentication.
        requireAuth: (req, res, next) => {
            if (!req.session || !req.session.isAuthenticated || !req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            next();
        },
    },
    // Avoid loading the whole agents router; mirror utils/routeHelpers.
    './agents': {
        getEffectiveUserId: (req) => req.session?.user?.id || req.session?.guestId || 'guest_anon',
    },
    '../pipeline/llmHelpers': {
        extractJSON: (s) => { try { return JSON.parse(s); } catch (_) { return null; } },
    },
    '../core/llm/llmClient': {
        chat: async () => { fx.llmCalls++; return { content: '{"memories":[{"type":"fact","content":"kaas"}]}' }; },
    },
    '../core/llm/modelResolver': {
        resolveModelForTier: async () => 'fast-model',
        getTierConfig: async () => ({ temperature: 0.2, maxTokens: 1000 }),
    },
    '../utils/perUserRateLimit': {
        // Pass-through: the limiter's own windowing is not under test here.
        perUserRateLimit: () => (req, res, next) => next(),
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:memory-authz:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]memory\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./memory');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method, url, session, body = {} }) {
    return new Promise((resolve, reject) => {
        // Express populates req.query from the query string and the router
        // reads it (GET /?projectId=... is the fixed UUID-enumeration path),
        // so the fake request has to populate it too.
        const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const query = Object.fromEntries(new URLSearchParams(qs));
        const req = { method, url, body, headers: {}, query, session, get() { return undefined; } };
        const res = {
            statusCode: 200,
            setHeader() { return this; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

const USER = { isAuthenticated: true, user: { id: 'u1' } };
const GUEST = { guestId: 'guest_abc' };                          // a visitor's guest cookie — NOT authentication
const CAROL = { isAuthenticated: true, user: { id: 'carol' } }; // a second signed-in user, no project roles
const BOB = { isAuthenticated: true, user: { id: 'bob' } };     // project-member perspective

test.beforeEach(() => {
    fx.rows = {
        // classification fixtures (owner scoping)
        'm-carol': { id: 'm-carol', user_id: 'carol', project_id: null, content: 'x' },
        'm-other': { id: 'm-other', user_id: 'u9', project_id: null, content: 'andermans' },
        'm-proj': { id: 'm-proj', user_id: 'u9', project_id: 'p1', content: 'project' },
        // regression fixtures (project-member surface)
        m1: { id: 'm1', project_id: 'p1', user_id: 'alice', content: 'shared', type: 'fact' },
        m2: { id: 'm2', project_id: null, user_id: 'bob', content: 'mine', type: 'fact' },
        m3: { id: 'm3', project_id: null, user_id: 'alice', content: 'hers', type: 'fact' },
    };
    fx.projectRole = false;
    fx.roleCalls.length = 0;
    fx.listCalls.length = 0;
    fx.createCalls.length = 0;
    fx.updateCalls.length = 0;
    fx.deleteCalls.length = 0;
    fx.clearCalls.length = 0;
    fx.llmCalls = 0;
});

// ═══ POST /import: the LLM route is authenticated ════════════════════

test('anonymous and guest-cookie callers get 401 on /import — no LLM call, no insert', async () => {
    for (const anon of [undefined, {}, GUEST]) {
        const res = await dispatch({ method: 'POST', url: '/import', session: anon, body: { text: 'x'.repeat(2000) } });
        assert.strictEqual(res.statusCode, 401, `session ${JSON.stringify(anon)}`);
        assert.deepStrictEqual(res.body, { error: 'Not authenticated' });
    }
    assert.strictEqual(fx.llmCalls, 0, 'the model is never invoked without a session user');
    assert.deepStrictEqual(fx.createCalls, [], 'nothing inserted');
});

test('a signed-in user imports normally (not 401) and rows land under their own id', async () => {
    const res = await dispatch({ method: 'POST', url: '/import', session: USER, body: { text: 'ik hou van kaas' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.imported, 1);
    assert.strictEqual(fx.llmCalls, 1);
    assert.strictEqual(fx.createCalls[0][0], 'u1', 'memory is created for the session user');
});

// ═══ The router is authenticated — a guest cookie is not a session ══

test('anonymous and guest-cookie callers get 401 on every route, and nothing is read or written', async () => {
    const routes = [
        { method: 'GET', url: '/' },
        { method: 'GET', url: '/stats' },
        { method: 'GET', url: '/m-carol' },
        { method: 'POST', url: '/', body: { content: 'mijn gast-notitie' } },
        { method: 'DELETE', url: '/m-carol' },
        { method: 'POST', url: '/bulk-delete', body: { ids: ['m-carol'] } },
    ];
    for (const anon of [undefined, {}, GUEST]) {
        for (const r of routes) {
            const res = await dispatch({ ...r, session: anon });
            assert.strictEqual(res.statusCode, 401, `${r.method} ${r.url} with session ${JSON.stringify(anon)}`);
        }
    }
    assert.deepStrictEqual(fx.listCalls, [], 'no list ran under a guest id');
    assert.deepStrictEqual(fx.createCalls, [], 'nothing inserted under a guest id');
    assert.deepStrictEqual(fx.deleteCalls, [], 'nothing deleted');
});

// ═══ …and the scoping that keeps signed-in users apart ═══════════════

test('a signed-in user lists memories, and only their own bucket is queried', async () => {
    const res = await dispatch({ method: 'GET', url: '/', session: CAROL });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.listCalls, ['carol'], 'the store is asked about the session user, nothing broader');
});

test('a signed-in user creates and deletes their own memory', async () => {
    const created = await dispatch({ method: 'POST', url: '/', session: CAROL, body: { content: 'mijn notitie' } });
    assert.strictEqual(created.statusCode, 200);
    assert.strictEqual(fx.createCalls[0][0], 'carol');

    const del = await dispatch({ method: 'DELETE', url: '/m-carol', session: CAROL });
    assert.strictEqual(del.statusCode, 200);
    assert.deepStrictEqual(fx.deleteCalls, ['m-carol']);
});

test("a signed-in user cannot read or delete another user's row — canAccessMemory refuses", async () => {
    for (const r of [{ method: 'GET', url: '/m-other' }, { method: 'DELETE', url: '/m-other' }, { method: 'PUT', url: '/m-other' }]) {
        const res = await dispatch({ ...r, session: CAROL, body: { content: 'kaap' } });
        assert.strictEqual(res.statusCode, 403, `${r.method} ${r.url}`);
    }
    assert.deepStrictEqual(fx.deleteCalls, [], 'nothing deleted across the user boundary');
});

test('project rows require a project role, which a user without one never holds', async () => {
    fx.projectRole = false;
    const read = await dispatch({ method: 'GET', url: '/m-proj', session: CAROL });
    assert.strictEqual(read.statusCode, 403);
    const write = await dispatch({ method: 'POST', url: '/', session: CAROL, body: { content: 'x', projectId: 'p1' } });
    assert.strictEqual(write.statusCode, 403);
    assert.deepStrictEqual(fx.createCalls, []);
});

test('bulk-delete silently skips rows outside the caller`s scope', async () => {
    const res = await dispatch({
        method: 'POST', url: '/bulk-delete', session: CAROL,
        body: { ids: ['m-carol', 'm-other', 'm-proj'] },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deleted, 1);
    assert.deepStrictEqual(fx.deleteCalls, ['m-carol'], 'only the caller`s own row goes');
});

// ═══ Regression: viewers must not be able to write ═══════════════════
// (the fixed userHasAccess bug: a read-only member could wipe a project's
//  entire shared memory pool)

test('a VIEWER cannot delete a project memory', async () => {
    fx.projectRole = 'viewer';

    const res = await dispatch({ method: 'DELETE', url: '/m1', session: BOB });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.deleteCalls, [], 'nothing deleted');
});

test('a VIEWER cannot update a project memory', async () => {
    fx.projectRole = 'viewer';

    const res = await dispatch({ method: 'PUT', url: '/m1', body: { content: 'tampered' }, session: BOB });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.updateCalls, []);
});

test('a VIEWER cannot create a project memory', async () => {
    fx.projectRole = 'viewer';

    const res = await dispatch({ method: 'POST', url: '/', body: { content: 'x', projectId: 'p1' }, session: BOB });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.createCalls, []);
});

test('a VIEWER cannot bulk-delete project memories', async () => {
    fx.projectRole = 'viewer';

    const res = await dispatch({ method: 'POST', url: '/bulk-delete', body: { ids: ['m1'] }, session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deleted, 0, 'reported zero deletions');
    assert.deepStrictEqual(fx.deleteCalls, [], 'and performed zero');
});

test('a VIEWER CAN still read a project memory', async () => {
    fx.projectRole = 'viewer';

    const res = await dispatch({ method: 'GET', url: '/m1', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.memory.id, 'm1');
});

test('an EDITOR can delete and update project memories', async () => {
    fx.projectRole = 'editor';

    assert.strictEqual((await dispatch({ method: 'DELETE', url: '/m1', session: BOB })).statusCode, 200);
    assert.deepStrictEqual(fx.deleteCalls, ['m1']);

    assert.strictEqual((await dispatch({ method: 'PUT', url: '/m1', body: { content: 'fixed' }, session: BOB })).statusCode, 200);
    assert.strictEqual(fx.updateCalls.length, 1);
});

// ═══ The role asked for is the right one ═════════════════════════════

test('reads ask for viewer, writes ask for editor', async () => {
    fx.projectRole = 'editor';

    await dispatch({ method: 'GET', url: '/m1', session: BOB });
    assert.strictEqual(fx.roleCalls.at(-1).minRole, 'viewer');

    await dispatch({ method: 'DELETE', url: '/m1', session: BOB });
    assert.strictEqual(fx.roleCalls.at(-1).minRole, 'editor');
});

// ═══ Non-project memories keep strict owner-only semantics ═══════════

test('a personal memory is reachable only by its owner', async () => {
    fx.projectRole = 'owner'; // irrelevant: no project_id, so no project path

    assert.strictEqual((await dispatch({ method: 'GET', url: '/m2', session: BOB })).statusCode, 200);
    assert.strictEqual((await dispatch({ method: 'GET', url: '/m3', session: BOB })).statusCode, 403,
        'another user\'s personal memory stays private even to a project owner');
    assert.strictEqual((await dispatch({ method: 'DELETE', url: '/m3', session: BOB })).statusCode, 403);
    assert.deepStrictEqual(fx.deleteCalls, []);
});

test('a personal memory needs no project lookup at all', async () => {
    await dispatch({ method: 'DELETE', url: '/m2', session: BOB });
    assert.strictEqual(fx.roleCalls.length, 0, 'no project role resolution for a personal row');
    assert.deepStrictEqual(fx.deleteCalls, ['m2']);
});

// ═══ Regression: guessing a project UUID ═════════════════════════════

test('listing a project\'s memories requires membership', async () => {
    fx.projectRole = false; // not a member

    const res = await dispatch({ method: 'GET', url: '/?projectId=p1', session: BOB });
    assert.strictEqual(res.statusCode, 403);

    // The member counterpart proves the 403 really is the membership check
    // (and that the harness delivers ?projectId= as req.query at all).
    fx.projectRole = 'viewer';
    const ok = await dispatch({ method: 'GET', url: '/?projectId=p1', session: BOB });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(fx.roleCalls.at(-1).minRole, 'viewer');
});

test('a non-member cannot read a project memory by id', async () => {
    fx.projectRole = false;

    const res = await dispatch({ method: 'GET', url: '/m1', session: BOB });
    assert.strictEqual(res.statusCode, 403);
});

test('a missing memory is 404, not 403 — no existence oracle inversion', async () => {
    fx.projectRole = 'editor';

    const res = await dispatch({ method: 'DELETE', url: '/does-not-exist', session: BOB });
    assert.strictEqual(res.statusCode, 404);
});

// ═══ Regression: "Clear All" in a project's Memory tab ═══════════════
// The panel sent POST /clear with no body from the project tab as well, and
// /clear only knew the personal clear: it deleted the member's PERSONAL
// memories and left the project's pool on the screen. A clear now names the
// project it means, and the project's pool is a write like any other: editor.

test('an editor clears the project\'s pool, and the personal memory is never touched', async () => {
    fx.projectRole = 'editor';

    const res = await dispatch({ method: 'POST', url: '/clear', session: BOB, body: { projectId: 'p1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.clearCalls, [{ what: 'project', projectId: 'p1' }],
        'the project pool is cleared, and clearAllMemories (the personal one) is not called');
    assert.deepStrictEqual(fx.roleCalls.at(-1), { userId: 'bob', projectId: 'p1', minRole: 'editor' },
        'the same check every other project write asks: editor on this project');
});

test('a VIEWER or a non-member cannot clear a project\'s pool, and nothing is cleared instead', async () => {
    for (const role of ['viewer', false]) {
        fx.projectRole = role;
        const res = await dispatch({ method: 'POST', url: '/clear', session: BOB, body: { projectId: 'p1' } });
        assert.strictEqual(res.statusCode, 403, `role ${role}`);
    }
    assert.deepStrictEqual(fx.clearCalls, [], 'refused means refused: no fallback to the personal clear');
});

test('a clear without a project is still the personal clear, with no project lookup', async () => {
    fx.projectRole = 'owner'; // irrelevant: no project named

    const res = await dispatch({ method: 'POST', url: '/clear', session: BOB, body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.clearCalls, [{ what: 'personal', userId: 'bob' }]);
    assert.strictEqual(fx.roleCalls.length, 0);
});
