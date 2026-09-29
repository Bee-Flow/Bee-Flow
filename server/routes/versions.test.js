/**
 * routes/versions.js under the concept/live split (A1):
 *   - POST /:agentId/:versionId/restore writes the CONCEPT (agentStore.updateAgent
 *     → config / system_prompt) and never the published_* columns — a restore
 *     is an edit that reaches users on the next POST /agents/:id/publish-version,
 *     which is what makes it the undo of an AI refine (kind:'pre_refine').
 *   - GET /:agentId lists the `kind` column so a client can tell an autosave
 *     from a published / pre-refine snapshot.
 * Dependencies stubbed via the Module resolve hook. The auth chain (requireAuth
 * + canModifyAgent) is stubbed permissive here — this file tests the A1
 * semantics; the gate itself is proven by routes/versions.authz.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/versions.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    versions: {},
    listed: [],
    agents: {},
    updateCalls: [],
    publishCalls: [],
    snapshotCalls: [],
    snapshotResult: null,
};

const MOCKS = {
    '../stores/versionStore': {
        getVersion: async (id) => fx.versions[id] || null,
        getVersions: async () => fx.listed.map(v => ({ ...v })),
    },
    '../stores/agentStore': {
        getAgent: async (id) => fx.agents[id] || null,
        updateAgent: async (...args) => { fx.updateCalls.push(args); return { ok: true }; },
        publishAgentVersion: async (...args) => { fx.publishCalls.push(args); return { ok: true }; },
        snapshotAgent: async (...args) => { fx.snapshotCalls.push(args); return fx.snapshotResult; },
    },
    '../auth': {
        // Mirrors the decision line of the real gate (auth/permissions.js); the
        // cached deleted-user DB re-check is out of scope for this unit test.
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
        canModifyAgent: async () => true, // permissive: authz is the other file's job
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:versions:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]versions\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./versions');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const request = { method, url, body, headers: {}, query: {}, session: { isAuthenticated: true, user: { id: 'u1' } }, get() { return undefined; } };
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

const SNAPSHOT = {
    id: 'a1', name: 'Old name', description: 'Old description', system_prompt: 'old prompt',
    owner_id: 'u1', model: 'tier:fast', starter_prompts: '["hi"]', avatar: null,
    threads_enabled: true, copy_enabled: true, workspace_enabled: false,
    config: '{"knowledge_base_ids":["kb1"]}', embed_enabled: false,
    organization_id: 'org1', shared_groups: '["g1"]',
    // A published-kind snapshot carries the raw row, published blobs included.
    published_config: { knowledge_base_ids: ['kb-published'] },
    published_system_prompt: 'published prompt', published_version: 3, published_rev: 7,
};

test.beforeEach(() => {
    // Both agents exist so a 404 in the cross-agent test below comes from the
    // version↔agent binding check, not from the agent lookup in the gate.
    fx.agents = {
        a1: { id: 'a1', owner_id: 'u1', organization_id: 'org1' },
        'other-agent': { id: 'other-agent', owner_id: 'u1', organization_id: 'org1' },
    };
    fx.versions = {
        v1: { id: 'v1', agent_id: 'a1', agent_type: 'agent', version_number: 4, kind: 'published', snapshot: SNAPSHOT },
    };
    fx.listed = [
        { id: 'v1', agent_id: 'a1', agent_type: 'agent', version_number: 4, kind: 'published' },
        { id: 'v0', agent_id: 'a1', agent_type: 'agent', version_number: 3, kind: 'autosave' },
    ];
    fx.updateCalls.length = 0;
    fx.publishCalls.length = 0;
    fx.snapshotCalls.length = 0;
    fx.snapshotResult = { id: 'v-pre', agent_id: 'a1', agent_type: 'agent', version_number: 5, kind: 'pre_refine' };
});

test('restore writes the concept via updateAgent and never publishes', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/v1/restore' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, restoredTo: 4 });

    assert.strictEqual(fx.updateCalls.length, 1, 'exactly one concept write');
    assert.strictEqual(fx.publishCalls.length, 0, 'published_* untouched — restore is an edit, not a publish');

    const args = fx.updateCalls[0];
    assert.strictEqual(args[0], 'a1');
    assert.strictEqual(args[1], 'Old name');
    assert.strictEqual(args[3], 'old prompt', 'the CONCEPT prompt, not the published one');
    assert.deepStrictEqual(args[11], { knowledge_base_ids: ['kb1'] }, 'the CONCEPT config, parsed');
    assert.deepStrictEqual(args[6], ['hi']);
    // Who may see the agent is not part of the concept: org and groups are
    // preserved (undefined), not written back from the snapshot. Pinned with
    // the reason in routes/versions.validation.test.js.
    assert.strictEqual(args[13], undefined);
    assert.strictEqual(args[14], undefined);
    // Nothing from the published side leaks into the concept write.
    for (const a of args) {
        assert.notStrictEqual(a, 'published prompt');
        if (a && typeof a === 'object') assert.ok(!('knowledge_base_ids' in a) || a.knowledge_base_ids[0] !== 'kb-published');
    }
});

test('restore refuses a version that belongs to another agent (404, nothing written)', async () => {
    const res = await dispatch({ method: 'POST', url: '/other-agent/v1/restore' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fx.updateCalls.length, 0);
    assert.strictEqual(fx.publishCalls.length, 0);
});

test('restore of an unknown version → 404, nothing written', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/nope/restore' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fx.updateCalls.length, 0);
});

test('GET /:agentId lists kind per version (published vs autosave)', async () => {
    const res = await dispatch({ method: 'GET', url: '/a1' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body));
    assert.deepStrictEqual(res.body.map(v => v.kind), ['published', 'autosave']);
});

// ── POST /:agentId/pre-refine — het undo-punt van de verfijn-rail ──────

test('pre-refine snapshots the agent as kind pre_refine and hands back the id', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/pre-refine' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: 'v-pre', version_number: 5, kind: 'pre_refine' });

    assert.strictEqual(fx.snapshotCalls.length, 1);
    const [agentId, userId, opts] = fx.snapshotCalls[0];
    assert.strictEqual(agentId, 'a1');
    assert.strictEqual(userId, 'u1');
    assert.strictEqual(opts.kind, 'pre_refine', "nooit 'published' — dat is het andere werkwoord");
    // Een snapshot is een LEESpunt, geen bewerking: er mag niets geschreven zijn.
    assert.strictEqual(fx.updateCalls.length, 0);
    assert.strictEqual(fx.publishCalls.length, 0);
});

test('pre-refine of an unknown agent is 404 and takes no snapshot', async () => {
    const res = await dispatch({ method: 'POST', url: '/nope/pre-refine' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fx.snapshotCalls.length, 0, 'de poort komt vóór de store');
});

test('a store that returns nothing is a 404, never a 200 with an empty id', async () => {
    // Anders krijgt de client een undo-knop die op `undefined` gaat herstellen —
    // en dat is precies de knop die "iets anders" terugzet.
    fx.snapshotResult = null;
    const res = await dispatch({ method: 'POST', url: '/a1/pre-refine' });
    assert.strictEqual(res.statusCode, 404);
});
