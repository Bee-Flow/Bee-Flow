/**
 * routes/versions.js authorization (U4b — closes the GEPIND_ONGEGATE finding).
 *
 * Before this gate the four /versions routes never touched req.session: agent
 * version snapshots (system prompt, config incl. tool params) were readable,
 * restorable and deletable by anonymous callers on guessed ids. The fix is the
 * sibling idiom from routes/agents: requireAuth on the router (anonymous →
 * 401), then per route ONE canModifyAgent(agent, userId, req) call — the same
 * per-agent write gate routes/agents/publishVersion.js uses. It applies to the
 * reads too: snapshots are DRAFT content, and the concept/live split (A1)
 * makes drafts a view only editors have (routes/agents/crud.js).
 *
 * canModifyAgent's own semantics (owner / super-admin / manage_agents within
 * the agent's org) are proven by routes/agents/crud.authz.test.js; here it is
 * a spy, and what is proven is that every route calls it and honors its
 * verdict — plus the version↔agent binding on DELETE, without which any
 * editor of any agent could delete versions of every other agent.
 *
 * Run: cd server && node --test --test-force-exit routes/versions.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    agents: {},          // id -> agent row
    versions: {},        // id -> version row
    canModify: false,    // the verdict the canModifyAgent spy returns
    canModifyCalls: [],  // spy: { agentId, userId, hasReq }
    listCalls: 0,
    getVersionCalls: 0,
    updateCalls: [],
    deleteCalls: [],
    snapshotCalls: [],
};

const MOCKS = {
    '../stores/versionStore': {
        getVersions: async () => { fx.listCalls++; return [{ id: 'v1', kind: 'published' }]; },
        getVersion: async (id) => { fx.getVersionCalls++; return fx.versions[id] || null; },
        deleteVersion: async (id) => { fx.deleteCalls.push(id); return true; },
    },
    '../stores/agentStore': {
        getAgent: async (id) => fx.agents[id] || null,
        updateAgent: async (...args) => { fx.updateCalls.push(args); return { ok: true }; },
        snapshotAgent: async (...args) => {
            fx.snapshotCalls.push(args);
            return { id: 'v-pre', version_number: 9, kind: 'pre_refine' };
        },
    },
    '../auth': {
        // Mirrors the decision line of the real requireAuth
        // (auth/permissions.js:383); the cached deleted-user DB re-check is
        // that gate's own concern, not this router's.
        requireAuth: (req, res, next) => {
            if (!req.session || !req.session.isAuthenticated || !req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            next();
        },
    },
    '../utils/routeHelpers': {
        getEffectiveUserId: (req) => req.session?.user?.id || 'guest',
    },
    './agents/crud': {
        canModifyAgent: async (agent, userId, req) => {
            fx.canModifyCalls.push({ agentId: agent?.id, userId, hasReq: !!req });
            return fx.canModify;
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:versions-authz:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]versions\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./versions');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method, url, session, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body, headers: {}, query: {}, session, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

const OWNER = { isAuthenticated: true, user: { id: 'u1' } };
const COLLEAGUE = { isAuthenticated: true, user: { id: 'u2' } };

const ALL_ROUTES = [
    { method: 'GET', url: '/a1' },
    { method: 'GET', url: '/a1/v1' },
    { method: 'POST', url: '/a1/v1/restore' },
    { method: 'POST', url: '/a1/pre-refine' },
    { method: 'DELETE', url: '/a1/v1' },
];

test.beforeEach(() => {
    fx.agents = { a1: { id: 'a1', owner_id: 'u1', organization_id: 'org1' } };
    fx.versions = {
        v1: {
            id: 'v1', agent_id: 'a1', agent_type: 'agent', version_number: 2,
            snapshot: { name: 'n', system_prompt: 'geheim', owner_id: 'u1', config: '{}' },
        },
    };
    fx.canModify = false;
    fx.canModifyCalls.length = 0;
    fx.listCalls = 0;
    fx.getVersionCalls = 0;
    fx.updateCalls.length = 0;
    fx.deleteCalls.length = 0;
    fx.snapshotCalls.length = 0;
});

// ═══ Anonymous → 401, before any data is touched ═════════════════════

test('anonymous callers get 401 on every route — no store call, no snapshot', async () => {
    for (const anon of [undefined, {}, { guestId: 'guest_abc' }]) {
        for (const r of ALL_ROUTES) {
            const res = await dispatch({ ...r, session: anon });
            assert.strictEqual(res.statusCode, 401, `${r.method} ${r.url} with session ${JSON.stringify(anon)}`);
            assert.deepStrictEqual(res.body, { error: 'Not authenticated' });
        }
    }
    assert.strictEqual(fx.listCalls + fx.getVersionCalls, 0, 'no version data read');
    assert.deepStrictEqual(fx.updateCalls, [], 'nothing restored');
    assert.deepStrictEqual(fx.deleteCalls, [], 'nothing deleted');
    assert.deepStrictEqual(fx.snapshotCalls, [], 'nothing snapshotted');
    assert.deepStrictEqual(fx.canModifyCalls, [], '401 happens before the agent gate runs');
});

// ═══ Authenticated but not an editor of THIS agent → 403 ═════════════

test('a signed-in non-editor is refused on every route with the structured 403', async () => {
    fx.canModify = false;
    for (const r of ALL_ROUTES) {
        const res = await dispatch({ ...r, session: COLLEAGUE });
        assert.strictEqual(res.statusCode, 403, `${r.method} ${r.url}`);
        assert.strictEqual(res.body.code, 'agent_not_editable', 'same body as routes/agents sendAgentNotEditable');
    }
    assert.strictEqual(fx.listCalls, 0, 'the version list never leaves the store');
    assert.strictEqual(fx.getVersionCalls, 0, 'no snapshot (system prompt!) is even loaded');
    assert.deepStrictEqual(fx.updateCalls, []);
    assert.deepStrictEqual(fx.deleteCalls, []);
    assert.deepStrictEqual(fx.snapshotCalls, [], 'a non-editor cannot even mint an undo point');
});

test('the gate asks canModifyAgent about the loaded agent, the session user and req', async () => {
    fx.canModify = false;
    await dispatch({ method: 'GET', url: '/a1', session: COLLEAGUE });
    assert.deepStrictEqual(fx.canModifyCalls, [{ agentId: 'a1', userId: 'u2', hasReq: true }],
        'req must be passed through — the org-membership half of canModifyAgent reads it');
});

// ═══ An editor (owner) passes ════════════════════════════════════════

test('the editor works: list, snapshot, restore and delete all succeed', async () => {
    fx.canModify = true;

    assert.strictEqual((await dispatch({ method: 'GET', url: '/a1', session: OWNER })).statusCode, 200);
    assert.strictEqual(fx.listCalls, 1);

    const snap = await dispatch({ method: 'GET', url: '/a1/v1', session: OWNER });
    assert.strictEqual(snap.statusCode, 200);
    assert.strictEqual(snap.body.snapshot.system_prompt, 'geheim');

    const restore = await dispatch({ method: 'POST', url: '/a1/v1/restore', session: OWNER });
    assert.strictEqual(restore.statusCode, 200);
    assert.deepStrictEqual(restore.body, { success: true, restoredTo: 2 });
    assert.strictEqual(fx.updateCalls.length, 1);

    const pre = await dispatch({ method: 'POST', url: '/a1/pre-refine', session: OWNER });
    assert.strictEqual(pre.statusCode, 200);
    assert.strictEqual(pre.body.id, 'v-pre');
    assert.strictEqual(fx.snapshotCalls.length, 1);

    const del = await dispatch({ method: 'DELETE', url: '/a1/v1', session: OWNER });
    assert.strictEqual(del.statusCode, 200);
    assert.deepStrictEqual(fx.deleteCalls, ['v1']);
});

// ═══ The gate binds to the RESOURCE, not just to a session ═══════════

test('an unknown agent is 404 before any version lookup', async () => {
    fx.canModify = true;
    const res = await dispatch({ method: 'GET', url: '/nope/v1', session: OWNER });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fx.getVersionCalls, 0);
});

test('DELETE refuses a version of ANOTHER agent — editorship of your own agent is not enough', async () => {
    // u1 edits a1, but v-other belongs to agent b2. Before the binding check,
    // deleteVersion(versionId) would have removed it anyway.
    fx.canModify = true;
    fx.agents.a1 = { id: 'a1', owner_id: 'u1', organization_id: 'org1' };
    fx.versions['v-other'] = { id: 'v-other', agent_id: 'b2', agent_type: 'agent', version_number: 9, snapshot: {} };

    const res = await dispatch({ method: 'DELETE', url: '/a1/v-other', session: OWNER });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(fx.deleteCalls, [], 'nothing deleted across the agent boundary');
});
