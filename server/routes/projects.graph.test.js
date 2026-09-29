/**
 * GET /:id/graph and GET /:id/completeness — the honest-degradation contract.
 *
 * Both routes are built on the same loader, and the loader is where a privacy
 * product's worst kind of bug used to live: an unreachable store returned `[]`,
 * which is indistinguishable from "this Solution has no agents". The Flow tab
 * then said "everything is connected" about a Solution half of which had not
 * been read, and the publish gate that reads the same aggregate would say
 * "nothing blocking".
 *
 * Three things are pinned here and nowhere else:
 *
 *   1. A STORE THAT THROWS IS NAMED, not silently emptied — `unavailable`
 *      carries the section and `complete` goes false.
 *   2. AN APP OR AGENT WHOSE SECOND READ FAILS DOES NOT VANISH. The listing
 *      gives meta; the wiring lives in the definition/config. Dropping the row
 *      removed its node, its edges AND its problems from the picture.
 *   3. "COULD NOT CHECK" IS NEVER REPORTED AS "GONE". The existence pass is
 *      all-or-nothing: one failed lookup abandons it, so an unplaced routine
 *      stays UNRESOLVED instead of becoming a MISSING error about a routine
 *      nobody looked at.
 *
 * Plus the completeness route's own refusal path: unknown BLOCKS publishing.
 *
 * Run: cd server && node --test --test-force-exit routes/projects.graph.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    role: 'viewer',
    fail: new Set(),          // section labels whose LISTING throws
    failApp: null,            // app id whose full read throws
    failAgent: null,          // agent id whose full read throws
    failKbSources: false,
    failExistence: false,
    automations: [],
    appMetas: [],
    apps: {},                 // id -> full app (with definition)
    webpages: [],
    datatables: [],
    agentMetas: [],
    agents: {},               // id -> full agent row
    projectKbIds: [],
    kbs: {},
    kbSources: {},            // kb id -> sources
    knownAutomations: {},     // id -> row, for the existence pass
    kbDocCounts: {},          // kb id -> { documentCount } | 'throw'
};

const MOCKS = {
    '../stores/projectStore': {
        getProject: async (id) => ({ id, name: 'P', ownerId: 'alice', organizationId: 'org1', knowledgeBaseIds: fx.projectKbIds }),
        logActivity: async () => {},
        appendProjectEvent: async () => ({ seq: 1, id: 'e1' }),
        normalizePermission: (p) => p,
    },
    '../stores/automationStore': {
        getAutomationsForProject: async () => {
            if (fx.fail.has('automations')) throw new Error('automation store down');
            return fx.automations;
        },
        getAutomation: async (id) => {
            if (fx.failExistence) throw new Error('automation store down');
            return fx.knownAutomations[id] || null;
        },
    },
    '../stores/studioAppStore': {
        listProjectApps: async () => {
            if (fx.fail.has('apps')) throw new Error('app store down');
            return fx.appMetas;
        },
        getStudioApp: async (id) => {
            if (fx.failApp === id) throw new Error('app read failed');
            return fx.apps[id] || null;
        },
    },
    '../stores/webpageStore': {
        listProjectWebpages: async () => {
            if (fx.fail.has('webpages')) throw new Error('webpage store down');
            return fx.webpages;
        },
    },
    '../stores/datatableStore': {
        listDatatablesForProject: async () => {
            if (fx.fail.has('datatables')) throw new Error('datatable store down');
            return fx.datatables;
        },
    },
    '../stores/agentStore': {
        listProjectAgents: async () => {
            if (fx.fail.has('agents')) throw new Error('agent store down');
            return fx.agentMetas;
        },
        getAgent: async (id) => {
            if (fx.failAgent === id) throw new Error('agent read failed');
            return fx.agents[id] || null;
        },
    },
    '../stores/knowledgeBases': {
        getKB: async (id) => {
            if (fx.fail.has('knowledgeBases')) throw new Error('knowledge base store down');
            return fx.kbs[id] || null;
        },
        countDocumentsByStatus: async (id) => {
            const v = fx.kbDocCounts[id];
            if (v === 'throw') throw new Error('document count failed');
            return v || { documentCount: 0, documentCountAll: 0, totalChunks: 0 };
        },
    },
    '../stores/kbSources': {
        listByKb: async (id) => {
            if (fx.failKbSources) throw new Error('kb source store down');
            return fx.kbSources[id] || [];
        },
    },
    '../stores/userStore': { getUser: async () => null, getAllGroups: async () => [] },
    '../support/kbAccess': { partitionAccessibleKBIds: async (_req, ids) => ({ allowed: ids, denied: [] }) },
    '../auth': { resolveUserGroups: async () => [] },
    '../core/projectEventBus': { publishProjectEvent: async () => {}, publishTransient: async () => {} },
    '../auth/projectAccess': {
        requireProjectRole: (minRole) => async function requireProjectRoleMw(req, res, next) {
            const order = { viewer: 0, editor: 1, owner: 2 };
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
    const mockId = `mock:projects-graph:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // completeness.js is deliberately in this list: it requires its stores
    // lazily, inside the aggregator, and without the double its knowledge-base
    // count would reach a real store, throw, be swallowed as "unknown" and make
    // every assertion below pass for the wrong reason.
    if (parent && /(routes[\\/]projects|projects[\\/](membership|knowledgeBaseMembership|completeness))\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./projects');
test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.role = 'viewer';
    fx.fail = new Set();
    fx.failApp = null;
    fx.failAgent = null;
    fx.failKbSources = false;
    fx.failExistence = false;
    // One app that runs one routine that lives in this project, so the happy
    // path has a real edge to lose.
    fx.appMetas = [{ id: 'app1', name: 'Desk' }];
    // A definition that BOTH validates clean and draws a run edge, so "no
    // findings" and "the edge is there" can be asserted from one fixture.
    fx.apps = {
        app1: {
            id: 'app1', name: 'Desk', userId: 'alice',
            definition: {
                schemaVersion: 2, meta: { name: 'Desk' },
                screens: [{ id: 's1', name: 'Home', sections: [{ id: 'sec1', children: [{ id: 'b1', type: 'button', props: { label: 'Go' }, onClick: 'act1' }] }] }],
                actions: { act1: { kind: 'run_automation', automationId: 'a1' } },
            },
        },
    };
    fx.automations = [{ id: 'a1', title: 'Nightly', userId: 'alice', isActive: false, isDraft: true, definition: { trigger: { id: 'trg1', kind: 'manual' }, steps: [], edges: [] } }];
    fx.webpages = [];
    fx.datatables = [];
    fx.agentMetas = [];
    fx.agents = {};
    fx.projectKbIds = [];
    fx.kbs = {};
    fx.kbSources = {};
    fx.knownAutomations = {};
    fx.kbDocCounts = {};
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

// ═══ The happy path stays exactly as it was ═══════════════════════════

test('a readable project draws its graph and says the picture is complete', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/p1/graph', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.unavailable, []);
    assert.strictEqual(res.body.complete, true);
    assert.ok(res.body.nodes.some(n => n.id === 'app:app1'), 'the app is a node');
    assert.ok(res.body.edges.some(e => e.from === 'app:app1' && e.targetId === 'a1'), 'the run edge is drawn');
    assert.deepStrictEqual(res.body.problems, [], 'a wired, same-owner edge is not a problem');
    assert.strictEqual(res.body.role, 'viewer');
});

// ═══ 1. A store that throws is NAMED ══════════════════════════════════

test('an unreachable store is named in `unavailable` instead of reading as empty', async () => {
    resetFx();
    fx.fail.add('agents');

    const res = await dispatch({ method: 'GET', url: '/p1/graph', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.unavailable, ['agents']);
    assert.strictEqual(res.body.complete, false, 'an unread kind means the picture is not whole');
    // …and the kinds that DID load are still drawn.
    assert.ok(res.body.nodes.some(n => n.id === 'app:app1'));
});

test('a failed automation listing does not turn every app edge into "nothing picked"', async () => {
    resetFx();
    fx.fail.add('automations');

    const res = await dispatch({ method: 'GET', url: '/p1/graph', session: ALICE });
    assert.ok(res.body.unavailable.includes('automations'));
    assert.strictEqual(res.body.complete, false);
});

// ═══ 2. A second read that fails must not delete the row ══════════════

test('an app whose definition cannot be read is counted, not dropped', async () => {
    resetFx();
    fx.failApp = 'app1';

    const res = await dispatch({ method: 'GET', url: '/p1/graph', session: ALICE });
    assert.deepStrictEqual(res.body.unavailable, ['apps']);
    assert.strictEqual(res.body.complete, false);
    // The app genuinely cannot be drawn — but the caller is told so rather
    // than shown a Solution that never contained it.
    assert.ok(!res.body.nodes.some(n => n.id === 'app:app1'));
});

test('an agent whose config cannot be read is counted, not dropped', async () => {
    resetFx();
    fx.agentMetas = [{ id: 'ag1', name: 'Helper' }];
    fx.agents = { ag1: { id: 'ag1', name: 'Helper', owner_id: 'alice', config: {} } };
    fx.failAgent = 'ag1';

    const res = await dispatch({ method: 'GET', url: '/p1/graph', session: ALICE });
    assert.deepStrictEqual(res.body.unavailable, ['agents']);
    assert.strictEqual(res.body.complete, false);
});

test('unreadable knowledge sources are counted — a missing meeting feed is not "no meeting feed"', async () => {
    resetFx();
    fx.projectKbIds = ['kb1'];
    fx.kbs = { kb1: { id: 'kb1', name: 'Handbook' } };
    fx.failKbSources = true;

    const res = await dispatch({ method: 'GET', url: '/p1/graph', session: ALICE });
    assert.deepStrictEqual(res.body.unavailable, ['knowledgeSources']);
    assert.strictEqual(res.body.complete, false);
    assert.ok(res.body.nodes.some(n => n.id === 'knowledge_base:kb1'), 'the base itself still draws');
});

// ═══ 3. "Could not check" is never reported as "gone" ═════════════════

test('a failed existence lookup leaves the routine UNRESOLVED rather than MISSING', async () => {
    resetFx();
    // The app points at a routine that is NOT in this project, so the second
    // pass runs — and its store is down.
    fx.apps.app1.definition.actions.act1.automationId = 'gone1';
    fx.failExistence = true;

    const res = await dispatch({ method: 'GET', url: '/p1/graph', session: ALICE });
    const codes = res.body.problems.map(p => p.code);
    assert.ok(codes.includes('unresolved'), `expected unresolved, got ${JSON.stringify(codes)}`);
    assert.ok(!codes.includes('missing'), 'never claim a routine is gone on an unanswered lookup');
    assert.ok(res.body.unavailable.includes('routineExistence'));
    assert.strictEqual(res.body.complete, false);
});

test('a completed existence pass still promotes a truly absent routine to MISSING', async () => {
    resetFx();
    fx.apps.app1.definition.actions.act1.automationId = 'gone1';

    const res = await dispatch({ method: 'GET', url: '/p1/graph', session: ALICE });
    const codes = res.body.problems.map(p => p.code);
    assert.ok(codes.includes('missing'), `expected missing, got ${JSON.stringify(codes)}`);
    assert.strictEqual(res.body.complete, true);
});

// ═══ Access ══════════════════════════════════════════════════════════

test('a non-member gets 404 from the graph, not an empty one', async () => {
    resetFx();
    fx.role = null;
    const res = await dispatch({ method: 'GET', url: '/p1/graph', session: ALICE });
    assert.strictEqual(res.statusCode, 404);
});

// ═══ GET /:id/completeness ═══════════════════════════════════════════

test('a clean Solution reports nothing blocking, and publishing is allowed', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/p1/completeness', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.findings, []);
    assert.strictEqual(res.body.blocked, false);
    assert.strictEqual(res.body.complete, true);
});

test('an unreadable store BLOCKS publishing — unknown is never the safer half', async () => {
    resetFx();
    fx.fail.add('automations');

    const res = await dispatch({ method: 'GET', url: '/p1/completeness', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.complete, false);
    assert.strictEqual(res.body.blocked, true,
        'a Solution half of which could not be read must not be publishable');
    assert.ok(res.body.unavailable.includes('automations'));
});

test('a broken app control surfaces as a finding with the app id filled in', async () => {
    resetFx();
    // A button wired to nothing: component.control_inert, the one app-validator
    // record that reaches the shared list.
    fx.apps.app1.definition = {
        schemaVersion: 2, meta: { name: 'Desk' },
        screens: [{ id: 's1', name: 'Home', sections: [{ children: [{ id: 'btn', type: 'button', props: {} }] }] }],
    };
    const res = await dispatch({ method: 'GET', url: '/p1/completeness', session: ALICE });
    const inert = res.body.findings.find(f => f.code === 'component.control_inert');
    assert.ok(inert, `expected control_inert, got ${JSON.stringify(res.body.findings.map(f => f.code))}`);
    assert.strictEqual(inert.targetRef.id, 'app1', 'the validator never sees the row — the aggregator threads it in');
    assert.strictEqual(inert.targetRef.title, 'Desk');
    assert.strictEqual(inert.deepLink, '/app/studio/apps/app1');
});

test('a non-member cannot read the control list', async () => {
    resetFx();
    fx.role = null;
    const res = await dispatch({ method: 'GET', url: '/p1/completeness', session: ALICE });
    assert.strictEqual(res.statusCode, 404);
});
