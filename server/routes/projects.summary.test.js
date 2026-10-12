/**
 * GET /api/projects/summary — the Solutions overview.
 *
 * What is load-bearing about the ROUTE (the aggregation itself is proved in
 * projects/summary.test.js):
 *
 *   1. IT IS NOT SWALLOWED BY /:id. A one-segment path under a router whose
 *      next entry is `GET /:id [requireProjectRole]`. Registered one line lower
 *      and every visit to the overview 404s, because "summary" is not a project.
 *      The route table freezes the position; this proves the behaviour.
 *   2. THE PROJECT LIST IS THE AUTHORISATION. There is no project role to check
 *      — the answer is a row per project the caller can already see — so
 *      `?ids=` may only ever INTERSECT that list. An id nobody checked must not
 *      reach a store.
 *   3. THE FAILURE PATH IS A SHAPE, NOT A BARE ERROR. A client that renders the
 *      body without looking at the status must show "nothing/unknown", never a
 *      clean overview.
 *
 * Run: cd server && node --test --test-force-exit routes/projects.summary.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    projects: [],
    listThrows: false,
    counted: [],          // every id list a counting store was handed
    runsAsked: null,
    graphed: [],
    roleGateCalls: 0,
};

const countStore = (name) => async (ids) => { fx.counted.push({ name, ids }); return new Map(); };

const MOCKS = {
    '../stores/projectStore': {
        listUserProjects: async (userId, groupIds, opts) => {
            fx.listOpts = opts ?? null;
            if (fx.listThrows) throw new Error('projects table is down');
            return fx.projects;
        },
        getProject: async () => null,
        getProjectShares: async () => [],
    },
    '../stores/notebookStore': { countProjectNotebooks: countStore('notebooks') },
    // Documents and meeting notes are counted too (projects/membership.js);
    // doubles, so the tally never reaches a real database.
    '../stores/documentStore': { countProjectDocuments: countStore('documents') },
    '../stores/transcriptionStore': { countProjectMeetings: countStore('meetings') },
    '../stores/studioAppStore': { countProjectApps: countStore('apps'), listProjectApps: async () => [], getStudioApp: async () => null },
    '../stores/webpageStore': { countProjectWebpages: countStore('webpages'), listProjectWebpages: async () => [] },
    '../stores/datatableStore': { countDatatablesForProject: countStore('datatables'), listDatatablesForProject: async () => [] },
    '../stores/agentStore': { countProjectAgents: countStore('agents'), listProjectAgents: async () => [] },
    '../stores/automationStore': {
        countAutomationsForProject: countStore('automations'),
        getRunCountsForProjects: async (ids, opts) => { fx.runsAsked = { ids, opts }; return new Map(); },
        getAutomationsForProject: async () => [],
        getAutomation: async () => null,
    },
    '../stores/blueprintStore': {
        listBlueprintsFor: async () => [],
        listInstalledVersions: async () => new Map(),
    },
    '../stores/kbSources': { listByKb: async () => [] },
    '../stores/userStore': { getUser: async () => null, getAllGroups: async () => [] },
    '../stores/knowledgeBases': { getKB: async () => null, countDocumentsByStatus: async () => ({ documentCount: 0 }) },
    '../support/kbAccess': { partitionAccessibleKBIds: async () => ({ allowed: [], denied: [] }) },
    '../auth': { resolveUserGroups: async () => [] },
    '../projects/knowledgeBaseMembership': {
        MAX_KB_IDS: 10,
        validateKnowledgeBaseIds: async () => ({ ok: true }),
        checkProjectKnowledgeBaseIds: async (_req, ids) => ({ ok: true, invalid: [], ids }),
        listProjectKnowledgeBases: async () => [],
    },
    '../projects/completeness': {
        collectCompleteness: async () => {
            fx.graphed.push('checked');
            return { blocked: false, complete: true, findings: [], unavailable: [] };
        },
    },
    '../auth/projectAccess': {
        requireProjectRole: () => async (req, res) => {
            // Reaching this from /summary means Express matched `/:id` with
            // "summary" as the id — the ordering regression this pins.
            fx.roleGateCalls += 1;
            return res.status(404).json({ error: 'Not found' });
        },
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:projects-summary:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // projects/summary.js and projects/membership.js are the code under test, so
    // they are NOT mocked — but the stores they reach for lazily must land on
    // the doubles too, or a real store would load, throw, and be reported as an
    // unavailable section while every assertion stayed green.
    if (parent && /(routes[\\/]projects|projects[\\/](summary|membership))\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./projects');
test.after(() => { Module._resolveFilename = originalResolve; });

const project = (id, over = {}) => ({
    id, name: `Solution ${id}`, ownerId: 'alice', organizationId: 'org1',
    permission: 'owner', knowledgeBaseIds: [], installedFromBlueprintId: null,
    updatedAt: '2026-09-01', ...over,
});

function reset(n = 2) {
    fx.projects = Array.from({ length: n }, (_, i) => project(`p${i + 1}`));
    fx.listThrows = false;
    fx.counted = [];
    fx.runsAsked = null;
    fx.graphed = [];
    fx.roleGateCalls = 0;
}

function dispatch(url, session = { user: { id: 'alice', organizationId: 'org1' } }) {
    return new Promise((resolve, reject) => {
        const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const query = Object.fromEntries(new URLSearchParams(qs));
        const req = { method: 'GET', url, body: {}, headers: {}, session, query, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: GET ${url}`)));
    });
}

// ═══ Ordering ════════════════════════════════════════════════════════

test('THE OVERVIEW IS NOT HANDED TO THE ROLE GATE AS A PROJECT CALLED "summary"', async () => {
    reset();
    const res = await dispatch('/summary');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.roleGateCalls, 0,
        'one line lower in the router and every visit to the overview 404s');
    assert.strictEqual(res.body.projects.length, 2);
});

// ═══ The project list IS the authorisation ═══════════════════════════

test('?ids= can only narrow the caller\'s own list, never reach past it', async () => {
    reset();
    const res = await dispatch('/summary?ids=p2,p_someone_elses');
    assert.deepStrictEqual(res.body.projects.map(p => p.id), ['p2']);
    assert.ok(fx.counted.some(c => c.name === 'documents') && fx.counted.some(c => c.name === 'meetings'),
        'documents and meeting notes are tallied through the same list');
    for (const call of fx.counted) {
        assert.deepStrictEqual(call.ids, ['p2'],
            `${call.name} was handed an id the caller was never checked against`);
    }
    assert.deepStrictEqual(fx.runsAsked.ids, ['p2']);
});

test('an id the caller has no role on yields nothing, not a 403 that confirms it exists', async () => {
    reset();
    const res = await dispatch('/summary?ids=p_someone_elses');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.projects, []);
    // The counting hooks are still invoked — with an EMPTY id list, which each
    // store short-circuits before it builds a statement. What must never happen
    // is the foreign id travelling into one.
    for (const call of fx.counted) assert.deepStrictEqual(call.ids, [], `${call.name} was handed an id`);
    assert.deepStrictEqual(fx.runsAsked.ids, []);
});

test('an unauthenticated caller gets 401, not an empty overview', async () => {
    reset();
    const res = await dispatch('/summary', {});
    assert.strictEqual(res.statusCode, 401);
});

// ═══ Bounds ══════════════════════════════════════════════════════════

test('the list is capped, and says when it was', async () => {
    reset(70);
    const res = await dispatch('/summary');
    assert.strictEqual(res.body.projects.length, 60);
    assert.strictEqual(res.body.hasMore, true);
});

test('a list within the cap does not claim there is more', async () => {
    reset(3);
    assert.strictEqual((await dispatch('/summary')).body.hasMore, false);
});

test('"since" is clamped to a week and never to the future', async () => {
    reset();
    await dispatch('/summary?since=2020-01-01T00:00:00.000Z');
    const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
    assert.ok(fx.runsAsked.opts.sinceTs.getTime() >= week - 5000,
        'a stray value must not turn a card tally into a full-table scan');

    fx.runsAsked = null;
    await dispatch('/summary?since=2099-01-01T00:00:00.000Z');
    assert.ok(fx.runsAsked.opts.sinceTs.getTime() <= Date.now() + 1000,
        'a client clock that runs ahead would otherwise report every Solution as idle today');
});

test('a nonsense "since" falls back to the default window rather than failing', async () => {
    reset();
    const res = await dispatch('/summary?since=yesterday-ish');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(fx.runsAsked.opts.sinceTs instanceof Date);
});

// ═══ Checks are on by default, and skipping them is reported ═════════

test('completeness is computed by default — a card without a health status is the thing this screen is for', async () => {
    reset(1);
    const res = await dispatch('/summary');
    assert.strictEqual(fx.graphed.length, 1);
    assert.strictEqual(res.body.projects[0].completeness.complete, true);
});

test('checks=0 skips the aggregation and says so on every card', async () => {
    reset(1);
    const res = await dispatch('/summary?checks=0');
    assert.deepStrictEqual(fx.graphed, []);
    assert.strictEqual(res.body.projects[0].completeness, null);
    assert.ok(res.body.projects[0].unavailable.includes('completeness'),
        'not checked is a REPORTED gap, never a clean bill of health');
});

// ═══ The failure path is a shape ═════════════════════════════════════

test('A 500 CARRIES AN EMPTY LIST AND NAMES THE GAP, NOT A BARE ERROR', async () => {
    reset();
    fx.listThrows = true;
    const res = await dispatch('/summary');
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body.projects, []);
    assert.deepStrictEqual(res.body.unavailable, ['all'],
        'a client that renders the body without checking the status shows nothing, not a clean overview');
    assert.strictEqual(res.body.hasMore, false);
    assert.ok(!/projects table/.test(JSON.stringify(res.body)), 'and no SQL text reaches the client');
});


// ═══ Solutions only ═══════════════════════════════════════════════════

test('the overview asks the store for Solutions (and unclassified legacy rows) only', async () => {
    reset();
    await dispatch('/summary');
    // The store keeps legacy rows (kind NULL) on both sides; a collaborative
    // project is never a card here.
    assert.deepStrictEqual(fx.listOpts, { kind: 'solution', includeArchived: true });
});
