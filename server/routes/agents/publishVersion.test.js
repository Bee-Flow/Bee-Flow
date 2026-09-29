/**
 * POST /agents/:id/publish-version — the content publish of the concept/live
 * split. Dependencies are stubbed via the Module resolve hook (same harness
 * as crud.authz.test.js); the router is dispatched directly.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/publishVersion.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    userId: 'owner',
    agents: {},
    canModify: true,
    validate: async () => ({ warnings: [], droppedSkillIds: [] }),
    publishCalls: [],
    publishImpl: null,
    versions: [],
    events: [],
};

const MOCKS = {
    '../../stores/agentStore': {
        getAgent: async (id) => fx.agents[id] || null,
        publishAgentVersion: async (id, opts) => { fx.publishCalls.push({ id, opts }); return fx.publishImpl(id, opts); },
    },
    '../../auth': { requireActiveOrgForMutations: () => (req, res, next) => next() },
    '../../utils/routeHelpers': { getEffectiveUserId: () => fx.userId },
    './crud': {
        canModifyAgent: async () => fx.canModify,
        validateAgentConfigReferences: (agent, cfg) => fx.validate(agent, cfg),
        // Stand-in for the real fold (unit-tested in crud.tools.test.js): the
        // route's job is to apply the verdict to the copy it publishes, and
        // this double keeps the two halves — dropped skills and clamped tool
        // grants — visible in the published config the assertions read.
        applyConfigValidation: (cfg, v) => {
            if (!cfg || !v) return cfg;
            let out = cfg;
            const drop = new Set(v.droppedSkillIds || []);
            if (drop.size > 0 && Array.isArray(cfg.attachedSkillIds)) {
                out = { ...out, attachedSkillIds: cfg.attachedSkillIds.filter(id => !drop.has(id)) };
            }
            if (v.tools) out = { ...out, tools: v.tools };
            return out;
        },
    },
    '../../stores/versionStore': { createVersion: async (...a) => { fx.versions.push(a); } },
    '../../compliance/events': { EVENTS: { AGENT_PUBLISHED: 'agent_published' }, emit: (n, p) => fx.events.push([n, p]) },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:publish-version:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]publishVersion\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./publishVersion');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch(url, body = {}) {
    return new Promise((resolve, reject) => {
        const request = { method: 'POST', url, body, headers: {}, query: {}, session: { user: { id: fx.userId } }, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: POST ${url}`)));
    });
}

const AGENT = (extra = {}) => ({
    id: 'a1', owner_id: 'owner', organization_id: 'orgA', rev: 4, is_published: true,
    config: { knowledge_base_ids: ['kb1'], attachedSkillIds: ['s1', 's-gone'] }, system_prompt: 'p', ...extra,
});

const okPublish = (id, opts) => ({
    ok: true,
    row: { id, rev: opts.expectedRev, published_version: 3, published_rev: opts.expectedRev, published_at: 'T', config: JSON.stringify(opts.config) },
    publishedVersion: 3, publishedRev: opts.expectedRev, publishedAt: 'T',
});

test.beforeEach(() => {
    fx.userId = 'owner'; fx.agents = { a1: AGENT() }; fx.canModify = true;
    fx.validate = async () => ({ warnings: [], droppedSkillIds: [] });
    fx.publishCalls.length = 0; fx.publishImpl = okPublish; fx.versions.length = 0; fx.events.length = 0;
});

test('happy path: validates, publishes with the CAS rev, writes a kind:published snapshot, emits Art-50 recheck', async () => {
    const res = await dispatch('/a1/publish-version');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.publishedVersion, 3);
    assert.strictEqual(res.body.publishedRev, 4);
    assert.strictEqual(res.body.rev, 4);
    assert.strictEqual(res.body.unpublishedChanges, 0);
    assert.strictEqual(res.body.runtimeSource, 'published');
    assert.strictEqual(fx.publishCalls.length, 1);
    assert.strictEqual(fx.publishCalls[0].opts.expectedRev, 4);
    assert.strictEqual(fx.versions.length, 1);
    assert.deepStrictEqual(fx.versions[0][5], { kind: 'published' });
    assert.strictEqual(fx.versions[0][4], 'Published v3');
    assert.deepStrictEqual(fx.events, [['agent_published', { orgId: 'orgA', agentId: 'a1' }]]);
});

test('unknown agent → 404', async () => {
    fx.agents = {};
    const res = await dispatch('/nope/publish-version');
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fx.publishCalls.length, 0);
});

test('not editable → 403 agent_not_editable, nothing published', async () => {
    fx.canModify = false;
    const res = await dispatch('/a1/publish-version');
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'agent_not_editable');
    assert.strictEqual(fx.publishCalls.length, 0);
});

test("owner_id='system' → 409 system_agent_follows_live (before any validation or write)", async () => {
    let validated = false;
    fx.validate = async () => { validated = true; return { warnings: [], droppedSkillIds: [] }; };
    fx.agents = { sys: AGENT({ id: 'sys', owner_id: 'system' }) };
    const res = await dispatch('/sys/publish-version');
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'system_agent_follows_live');
    assert.strictEqual(validated, false);
    assert.strictEqual(fx.publishCalls.length, 0);
});

test('a cross-org KB in the concept → 400 from validateAgentConfigReferences, nothing published', async () => {
    fx.validate = async () => { const e = new Error('Agent owner cannot access: knowledge base kb1'); e.status = 400; throw e; };
    const res = await dispatch('/a1/publish-version');
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /knowledge base kb1/);
    assert.strictEqual(fx.publishCalls.length, 0);
});

test('an unresolvable skill is dropped from the PUBLISHED copy and reported as a warning', async () => {
    fx.validate = async () => ({ warnings: ['skill s-gone'], droppedSkillIds: ['s-gone'] });
    const res = await dispatch('/a1/publish-version');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.warnings, ['skill s-gone']);
    assert.deepStrictEqual(fx.publishCalls[0].opts.config.attachedSkillIds, ['s1']);
});

test('concurrent save: one retry on conflict re-reads the fresh rev, then publishes', async () => {
    let n = 0;
    fx.publishImpl = (id, opts) => {
        n++;
        if (n === 1) { fx.agents.a1 = AGENT({ rev: 5 }); return { ok: false, conflict: true, currentRev: 5 }; }
        return okPublish(id, opts);
    };
    const res = await dispatch('/a1/publish-version');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.publishCalls.length, 2);
    assert.strictEqual(fx.publishCalls[1].opts.expectedRev, 5);
    assert.strictEqual(res.body.publishedRev, 5);
});

test('still conflicting after the retry → 409 conflict', async () => {
    fx.publishImpl = () => ({ ok: false, conflict: true, currentRev: 9 });
    const res = await dispatch('/a1/publish-version');
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.conflict, true);
    assert.strictEqual(res.body.currentVersion, 9);
    assert.strictEqual(fx.versions.length, 0);
});

test('no compliance event for an agent without an audience (is_published false)', async () => {
    fx.agents = { a1: AGENT({ is_published: false }) };
    const res = await dispatch('/a1/publish-version');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.events, []);
});
