/**
 * Notebooks, apps and routines inside a project.
 *
 * Three invariants, and each of them was a real gap before this:
 *
 *   1. DELETING A PROJECT MUST NOT DESTROY WHAT MEMBERS BUILT IN IT.
 *      notebooks.project_id, automations.project_id and studio_apps.project_id
 *      are SOFT references (no FK) precisely so a project delete detaches
 *      rather than cascades. Nothing cleared them, though — the automations
 *      migration's header promised a `clearProjectFromAutomations` by name and
 *      it was never written, so a deleted project left automations pointing at
 *      nothing: absent from the project list and unfindable in the standalone
 *      one.
 *
 *   2. MOVING SOMETHING IN OR OUT NEEDS BOTH editor ON THE PROJECT AND
 *      OWNERSHIP OF THE RESOURCE. A project editor pulling a colleague's
 *      private notebook into a shared project would be a disclosure, not a
 *      filing decision.
 *
 *   3. ONE UNAVAILABLE STORE MUST NOT BLANK THE WHOLE PROJECT PAGE.
 *
 * Run: cd server && node --test routes/projects.resources.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    role: 'editor',
    // resource id -> owner id
    notebookOwners: {},
    appOwners: {},
    webpageOwners: {},
    datatableOwners: {},
    agentOwners: {},
    automations: {},
    calls: [],
    failList: null,       // store label whose list call should throw
    deleted: false,
    // The knowledge-base kind has no project_id column: its link is an entry in
    // the project's own knowledge_base_ids, so the project row IS the fixture.
    project: null,
    kbs: {},              // kb id -> row
    readableKBs: [],      // which of them this caller may READ
    kbConflicts: 0,       // compare-and-swap losses to simulate before winning
};

function record(name, args) { fx.calls.push({ name, args }); }

const MOCKS = {
    '../stores/projectStore': {
        getProject: async (id) => (fx.project ? { id, ...fx.project } : null),
        updateProject: async (id, updates, opts) => {
            record('updateProject', { id, updates, expectedVersion: opts?.expectedVersion ?? null });
            if (fx.kbConflicts > 0) { fx.kbConflicts -= 1; fx.project.version += 1; return { conflict: true, current: { id, ...fx.project } }; }
            if (updates.knowledgeBaseIds !== undefined) fx.project.knowledgeBaseIds = updates.knowledgeBaseIds;
            fx.project.version += 1;
            return { id, ...fx.project };
        },
        deleteProject: async () => { fx.deleted = true; return true; },
        logActivity: async () => {},
        appendProjectEvent: async () => ({ seq: 1, id: 'e1' }),
        listUserProjects: async () => [],
        getProjectShares: async () => [],
        normalizePermission: (p) => p,
    },
    '../stores/notebookStore': {
        listProjectNotebooks: async (projectId) => {
            if (fx.failList === 'notebooks') throw new Error('notebook store down');
            record('listNotebooks', { projectId });
            return [{ id: 'nb1', name: 'Notes' }];
        },
        setNotebookProject: async (id, userId, projectId) => {
            record('setNotebookProject', { id, userId, projectId });
            return fx.notebookOwners[id] === userId;
        },
        clearProjectFromNotebooks: async (projectId) => { record('clearNotebooks', { projectId }); return 1; },
    },
    '../stores/automationStore': {
        getAutomationsForProject: async (projectId) => {
            if (fx.failList === 'automations') throw new Error('automation store down');
            record('listAutomations', { projectId });
            return [{ id: 'a1', title: 'Nightly' }];
        },
        getAutomation: async (id) => fx.automations[id] || null,
        updateAutomation: async (id, updates) => { record('updateAutomation', { id, updates }); },
        clearProjectFromAutomations: async (projectId) => { record('clearAutomations', { projectId }); return 2; },
        listApprovals: async ({ viewer, projectId }) => {
            if (fx.failList === 'approvals') throw new Error('approval store down');
            record('listApprovals', { projectId, viewerId: viewer?.userId ?? null });
            return { approvals: [{ id: 'apr1', prompt: 'Ship it?' }], nextCursor: null };
        },
    },
    '../stores/studioAppStore': {
        listProjectApps: async (projectId) => {
            if (fx.failList === 'apps') throw new Error('app store down');
            record('listApps', { projectId });
            return [{ id: 'app1', name: 'Tracker' }];
        },
        setAppProject: async (id, userId, projectId) => {
            record('setAppProject', { id, userId, projectId });
            return fx.appOwners[id] === userId;
        },
        clearProjectFromApps: async (projectId) => { record('clearApps', { projectId }); return 3; },
    },
    '../stores/webpageStore': {
        listProjectWebpages: async (projectId) => {
            if (fx.failList === 'webpages') throw new Error('webpage store down');
            record('listWebpages', { projectId });
            return [{ id: 'wp1', name: 'Status page' }];
        },
        setWebpageProject: async (id, userId, projectId) => {
            record('setWebpageProject', { id, userId, projectId });
            return fx.webpageOwners[id] === userId;
        },
        clearProjectFromWebpages: async (projectId) => { record('clearWebpages', { projectId }); return 4; },
    },
    '../stores/datatableStore': {
        listDatatablesForProject: async (projectId) => {
            if (fx.failList === 'datatables') throw new Error('datatable store down');
            record('listDatatables', { projectId });
            return [{ id: 'tbl1', name: 'Invoices', ownerUserId: 'alice' }];
        },
        setDatatableProject: async (id, userId, projectId) => {
            record('setDatatableProject', { id, userId, projectId });
            return fx.datatableOwners[id] === userId;
        },
        clearProjectFromDatatables: async (projectId) => { record('clearDatatables', { projectId }); return 5; },
    },
    '../stores/agentStore': {
        listProjectAgents: async (projectId) => {
            if (fx.failList === 'agents') throw new Error('agent store down');
            record('listAgents', { projectId });
            return [{ id: 'ag1', name: 'Helper', ownerId: 'alice' }];
        },
        setAgentProject: async (id, userId, projectId) => {
            record('setAgentProject', { id, userId, projectId });
            return fx.agentOwners[id] === userId;
        },
        clearProjectFromAgents: async (projectId) => { record('clearAgents', { projectId }); return 6; },
    },
    '../stores/userStore': { getUser: async () => null, getAllGroups: async () => [] },
    '../stores/knowledgeBases': {
        getKB: async (id) => {
            if (fx.failList === 'knowledgeBases') throw new Error('knowledge base store down');
            record('getKB', { id });
            return fx.kbs[id] || null;
        },
    },
    '../support/kbAccess': {
        partitionAccessibleKBIds: async (_req, ids) => ({
            allowed: ids.filter(id => fx.readableKBs.includes(id)),
            denied: ids.filter(id => !fx.readableKBs.includes(id)),
        }),
    },
    '../auth': { resolveUserGroups: async () => [] },
    '../core/projectEventBus': { publishProjectEvent: async () => {}, publishTransient: async () => {} },
    '../auth/projectAccess': {
        requireProjectRole: (minRole) => async (req, res, next) => {
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
    const mockId = `mock:projects-resources:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // knowledgeBaseMembership.js is deliberately NOT mocked — it is the adapter
    // under test — but ITS store requires have to reach the doubles too, or the
    // knowledge-base section would fall through to a real store, throw at load,
    // be caught by the route's `load()` wrapper and come back as null while
    // every existing assertion stayed green.
    if (parent && /(routes[\\/]projects|projects[\\/](membership|knowledgeBaseMembership))\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./projects');
test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.role = 'editor';
    fx.notebookOwners = { nb1: 'alice' };
    fx.appOwners = { app1: 'alice' };
    fx.webpageOwners = { wp1: 'alice' };
    fx.datatableOwners = { tbl1: 'alice' };
    fx.agentOwners = { ag1: 'alice' };
    fx.automations = { a1: { id: 'a1', userId: 'alice' } };
    fx.calls.length = 0;
    fx.failList = null;
    fx.deleted = false;
    fx.project = {
        name: 'P', ownerId: 'alice', organizationId: 'org1',
        knowledgeBaseIds: ['kb1'], version: 4,
    };
    fx.kbs = {
        kb1: { id: 'kb1', name: 'Handbook', organization_id: 'org1' },
        kb2: { id: 'kb2', name: 'Policies', organization_id: 'org1' },
        kb_other: { id: 'kb_other', name: 'Someone else\'s', organization_id: 'org2' },
    };
    fx.readableKBs = ['kb1', 'kb2'];
    fx.kbConflicts = 0;
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

// ═══ Listing ═════════════════════════════════════════════════════════

test('a project lists its notebooks, automations and apps together', async () => {
    resetFx();
    fx.role = 'viewer';

    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.notebooks.length, 1);
    assert.strictEqual(res.body.automations.length, 1);
    assert.strictEqual(res.body.apps.length, 1);
    assert.strictEqual(res.body.role, 'viewer');
});

test('one unavailable store degrades its own section, not the page', async () => {
    resetFx();
    fx.failList = 'automations';

    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.automations, null, 'null means "could not load"');
    assert.strictEqual(res.body.notebooks.length, 1, 'the rest still renders');
    assert.strictEqual(res.body.apps.length, 1);
});

test('a non-member cannot list a project\'s resources', async () => {
    resetFx();
    fx.role = null;

    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: BOB });
    assert.strictEqual(res.statusCode, 404);
});

// ═══ Filing something in and out ═════════════════════════════════════

test('an owner-editor can file their own notebook into the project', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'notebook', id: 'nb1', attach: true }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 200);
    const call = fx.calls.find(c => c.name === 'setNotebookProject');
    assert.deepStrictEqual(call.args, { id: 'nb1', userId: 'alice', projectId: 'p1' });
});

test('detaching passes a null project id', async () => {
    resetFx();
    await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'notebook', id: 'nb1', attach: false }, session: ALICE,
    });
    const call = fx.calls.find(c => c.name === 'setNotebookProject');
    assert.strictEqual(call.args.projectId, null);
});

test('an editor CANNOT file a notebook they do not own', async () => {
    resetFx();
    fx.notebookOwners = { nb1: 'alice' };   // Bob is an editor, but not the owner

    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'notebook', id: 'nb1' }, session: BOB,
    });
    assert.strictEqual(res.statusCode, 404,
        'pulling a colleague\'s private notebook into a shared project is a disclosure');
});

test('an editor CANNOT file an app they do not own', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'app', id: 'app1' }, session: BOB,
    });
    assert.strictEqual(res.statusCode, 404);
});

test('an editor CANNOT file an automation they do not own', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'automation', id: 'a1' }, session: BOB,
    });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!fx.calls.some(c => c.name === 'updateAutomation'), 'nothing written');
});

test('a VIEWER cannot file anything at all', async () => {
    resetFx();
    fx.role = 'viewer';

    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'notebook', id: 'nb1' }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 403);
});

test('an unknown kind is rejected', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'spaceship', id: 'x' }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 400);
});

test('kind and id are both required', async () => {
    resetFx();
    assert.strictEqual((await dispatch({ method: 'PUT', url: '/p1/resources', body: { id: 'nb1' }, session: ALICE })).statusCode, 400);
    assert.strictEqual((await dispatch({ method: 'PUT', url: '/p1/resources', body: { kind: 'notebook' }, session: ALICE })).statusCode, 400);
});

// ═══ Deleting a project detaches, never destroys ═════════════════════

test('deleting a project detaches notebooks, automations AND apps first', async () => {
    resetFx();
    fx.role = 'owner';

    const res = await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
    assert.strictEqual(res.statusCode, 200);

    const names = fx.calls.map(c => c.name);
    assert.ok(names.includes('clearNotebooks'), 'notebooks detached');
    assert.ok(names.includes('clearAutomations'), 'automations detached — the cleanup the migration promised');
    assert.ok(names.includes('clearApps'), 'apps detached');
    assert.strictEqual(fx.deleted, true, 'and the project itself is gone');
});

test('a failing detacher does not block the delete', async () => {
    resetFx();
    fx.role = 'owner';
    const original = MOCKS['../stores/notebookStore'].clearProjectFromNotebooks;
    MOCKS['../stores/notebookStore'].clearProjectFromNotebooks = async () => { throw new Error('store down'); };
    try {
        const res = await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(fx.deleted, true, 'a half-removed project is worse than an orphaned project_id');
        assert.ok(fx.calls.some(c => c.name === 'clearApps'), 'later detachers still run');
    } finally {
        MOCKS['../stores/notebookStore'].clearProjectFromNotebooks = original;
    }
});

// ═══ Webpages and approvals: the two kinds that complete the Solution ═

test('a project lists its webpages and approvals alongside the rest', async () => {
    resetFx();
    fx.role = 'viewer';

    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.webpages.length, 1, 'webpages are in the project');
    assert.strictEqual(res.body.approvals.length, 1, 'and so are approvals');
});

test('approvals are listed against the CALLER, not the project', async () => {
    resetFx();
    fx.role = 'viewer';

    await dispatch({ method: 'GET', url: '/p1/resources', session: BOB });
    const call = fx.calls.find(c => c.name === 'listApprovals');
    assert.ok(call, 'the approvals section was loaded');
    assert.strictEqual(call.args.projectId, 'p1', 'narrowed to this project');
    // The security half: projectId narrows the viewer's own scope, it does not
    // replace it. Dropping the viewer here would hand every project member the
    // questions, details and attachments of decisions addressed to other people.
    assert.strictEqual(call.args.viewerId, 'bob', 'and intersected with who is asking');
});

test('an owner-editor can file their own webpage into the project', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'webpage', id: 'wp1', attach: true }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 200);
    const call = fx.calls.find(c => c.name === 'setWebpageProject');
    assert.deepStrictEqual(call.args, { id: 'wp1', userId: 'alice', projectId: 'p1' });
});

test('an editor CANNOT file a webpage they do not own', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'webpage', id: 'wp1', attach: true }, session: BOB,
    });
    assert.strictEqual(res.statusCode, 404, 'not yours to move');
});

test('an approval cannot be filed in or out — it is stamped, not moved', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'approval', id: 'apr1', attach: true }, session: ALICE,
    });
    // Re-filing an automation moves its FUTURE approvals; a decision already
    // taken keeps naming where it was taken.
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!fx.calls.some(c => c.name === 'listApprovals'), 'and nothing was moved');
});

test('deleting a project detaches webpages, but NEVER approvals', async () => {
    resetFx();
    fx.role = 'owner';

    await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });

    const names = fx.calls.map(c => c.name);
    assert.ok(names.includes('clearWebpages'), 'a page survives its project, like every other resource');
    // An approval is a record, not a resource. It keeps its project_id and
    // project_title so the archived row still says where the decision happened
    // — exactly as automation_title outlives a deleted automation.
    assert.ok(!names.some(n => /clearApprovals/i.test(n)), 'approvals are records and are never detached');
});

test('one unavailable store still degrades only its own section', async () => {
    resetFx();
    fx.role = 'viewer';
    fx.failList = 'webpages';

    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.webpages, null, 'null = unavailable, distinct from [] = none');
    assert.strictEqual(res.body.apps.length, 1, 'the rest of the page is unaffected');
});

// ═══ Tables, agents and knowledge bases ══════════════════════════════
//
// Three kinds whose sections could go WRONG SILENTLY. A store this test file
// does not mock resolves to the real one, throws at load without a database,
// gets caught by the route's `load()` wrapper and comes back as `null` — and
// every assertion above stays green while the section is dead. So each of the
// three is asserted NON-EMPTY here: `null` fails, `[]` fails.

test('a project lists its tables, agents and knowledge bases too', async () => {
    resetFx();
    fx.role = 'viewer';

    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.datatables?.length, 1, 'null here would mean the store was never wired');
    assert.strictEqual(res.body.agents?.length, 1);
    assert.strictEqual(res.body.knowledgeBases?.length, 1);
    assert.strictEqual(res.body.knowledgeBases[0].name, 'Handbook');
});

test('the knowledge-base listing carries the name, never the base\'s governance', async () => {
    resetFx();
    fx.kbs.kb1 = {
        id: 'kb1', name: 'Handbook', description: 'how we work', icon: '📘',
        category_id: 'cat1', organization_id: 'org1',
        tenant_id: 'alice', is_published: false, shared_groups: ['grp_hr'],
    };
    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: ALICE });
    const kb = res.body.knowledgeBases[0];
    assert.deepStrictEqual(Object.keys(kb).sort(),
        ['categoryId', 'description', 'icon', 'id', 'name', 'projectId']);
    assert.ok(!JSON.stringify(kb).includes('grp_hr'), 'who may read the base is the base\'s business');
});

test('a knowledge base that cannot be READ blanks its own section, not the list', async () => {
    // The fail-open shape this rejects: swallowing the store error would render
    // "Nothing here yet" and tell someone the project has no knowledge bases.
    resetFx();
    fx.failList = 'knowledgeBases';

    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.knowledgeBases, null, 'null = could not load');
    assert.strictEqual(res.body.datatables.length, 1, 'the rest of the page is unaffected');
});

test('a knowledge base that is GONE is simply absent — that is a deletion, not a failure', async () => {
    resetFx();
    fx.project.knowledgeBaseIds = ['kb1', 'kb_deleted'];
    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: ALICE });
    assert.strictEqual(res.body.knowledgeBases.length, 1);
    assert.strictEqual(res.body.knowledgeBases[0].id, 'kb1');
});

test('an owner-editor can file their own table and their own agent', async () => {
    resetFx();
    const table = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'datatable', id: 'tbl1', attach: true }, session: ALICE,
    });
    assert.strictEqual(table.statusCode, 200);
    assert.deepStrictEqual(fx.calls.find(c => c.name === 'setDatatableProject').args,
        { id: 'tbl1', userId: 'alice', projectId: 'p1' });

    const agent = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'agent', id: 'ag1', attach: true }, session: ALICE,
    });
    assert.strictEqual(agent.statusCode, 200);
    assert.deepStrictEqual(fx.calls.find(c => c.name === 'setAgentProject').args,
        { id: 'ag1', userId: 'alice', projectId: 'p1' });
});

test('an editor CANNOT file a table or an agent they do not own', async () => {
    resetFx();
    for (const kind of [['datatable', 'tbl1'], ['agent', 'ag1']]) {
        const res = await dispatch({
            method: 'PUT', url: '/p1/resources',
            body: { kind: kind[0], id: kind[1] }, session: BOB,
        });
        assert.strictEqual(res.statusCode, 404, `${kind[0]}: not yours to move`);
    }
});

// ── Attaching a knowledge base is a READ GRANT ──────────────────────

test('attaching a knowledge base the caller cannot read is refused', async () => {
    // Project chat searches these ids with no further check, so a project
    // editor naming any kb id would be reading a base they have no access to.
    resetFx();
    fx.readableKBs = ['kb1'];               // kb2 is not theirs to read

    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'knowledge_base', id: 'kb2', attach: true }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!fx.calls.some(c => c.name === 'updateProject'), 'and nothing was written');
    assert.deepStrictEqual(fx.project.knowledgeBaseIds, ['kb1']);
});

test('attaching a knowledge base from ANOTHER organisation is refused', async () => {
    resetFx();
    fx.readableKBs = ['kb1', 'kb_other'];   // readable, but not this tenant's
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'knowledge_base', id: 'kb_other', attach: true }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(fx.project.knowledgeBaseIds, ['kb1']);
});

test('attaching a readable knowledge base writes it with the version it read', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'knowledge_base', id: 'kb2', attach: true }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 200);
    const write = fx.calls.find(c => c.name === 'updateProject');
    assert.deepStrictEqual(write.args.updates.knowledgeBaseIds, ['kb1', 'kb2']);
    // Without the compare-and-swap this whole-array replace deletes whatever a
    // colleague added a second earlier and answers 200.
    assert.strictEqual(write.args.expectedVersion, 4);
});

test('attaching one that is already there changes nothing and still succeeds', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'knowledge_base', id: 'kb1', attach: true }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!fx.calls.some(c => c.name === 'updateProject'), 'no write, so no version bump under an open editor');
});

test('taking a knowledge base out needs no read access at all', async () => {
    // Removing an id from the project\'s own list reveals nothing, and a member
    // must always be able to take out a base the project should not have.
    resetFx();
    fx.readableKBs = [];
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'knowledge_base', id: 'kb1', attach: false }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.project.knowledgeBaseIds, []);
});

test('a lost race is re-applied against the fresh row, not reported as success', async () => {
    resetFx();
    fx.kbConflicts = 1;
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'knowledge_base', id: 'kb2', attach: true }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 200);
    const writes = fx.calls.filter(c => c.name === 'updateProject');
    assert.strictEqual(writes.length, 2, 'the first attempt lost and was retried');
    assert.strictEqual(writes[1].args.expectedVersion, 5, 'and re-read the version it lost to');
    assert.deepStrictEqual(fx.project.knowledgeBaseIds, ['kb1', 'kb2']);
});

test('a race it keeps losing is a 409, never a silent overwrite', async () => {
    resetFx();
    fx.kbConflicts = 99;
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'knowledge_base', id: 'kb2', attach: true }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 409);
    assert.match(res.body.error, /at the same time/);
    assert.deepStrictEqual(fx.project.knowledgeBaseIds, ['kb1'], 'and the colleague\'s change survives');
});

test('a viewer cannot file a table, an agent or a knowledge base', async () => {
    resetFx();
    fx.role = 'viewer';
    for (const kind of ['datatable', 'agent', 'knowledge_base']) {
        const res = await dispatch({
            method: 'PUT', url: '/p1/resources', body: { kind, id: 'x' }, session: ALICE,
        });
        assert.strictEqual(res.statusCode, 403, kind);
    }
});

test('deleting a project detaches tables and agents, but NEVER knowledge bases', async () => {
    resetFx();
    fx.role = 'owner';

    await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });

    const names = fx.calls.map(c => c.name);
    assert.ok(names.includes('clearDatatables'), 'a table survives its project');
    assert.ok(names.includes('clearAgents'), 'and so does an agent');
    // There is nothing to detach: the link is an entry on the project row that
    // goes with it. A detacher here would be a promise with no column behind it.
    assert.ok(!names.some(n => /clearKnowledge|clearKB/i.test(n)));
});
