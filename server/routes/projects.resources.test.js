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
    sharedThreads: 0,     // conversations still shared into the project
    // The knowledge-base kind has no project_id column: its link is an entry in
    // the project's own knowledge_base_ids, so the project row IS the fixture.
    project: null,
    kbs: {},              // kb id -> row
    readableKBs: [],      // which of them this caller may READ
    kbConflicts: 0,       // compare-and-swap losses to simulate before winning
    documentOwners: {},
    meetingOwners: {},
    filesKbRemoved: [],   // projects handed to projectFiles.removeFilesKb
    filesKbRemoveFails: false,
    counts: {},           // section -> how many the project holds (countIn)
    chatHoldings: { conversations: 0, teamChats: 0 },
    files: [],            // the project's uploaded files
    activity: [],         // listActivity rows
};

/** A registry countIn double: `fx.counts[section]` for every project asked about. */
const countOf = (section) => async (ids) => {
    record('count', { section });
    return new Map(ids.map((id) => [id, fx.counts[section] || 0]));
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
        setProjectKind: async (id, kind) => {
            record('setProjectKind', { id, kind });
            if (!fx.project || (fx.project.kind != null && !fx.project.kindGuessed)) return null;
            Object.assign(fx.project, { kind, kindGuessed: false });
            return { id, ...fx.project };
        },
        countChatHoldings: async () => fx.chatHoldings,
        listActivity: async () => fx.activity,
        countSharedThreads: async () => fx.sharedThreads,
        listSharedThreads: async (projectId, { limit } = {}) => {
            record('listSharedThreads', { projectId, limit });
            return Array.from({ length: Math.min(fx.sharedThreads, limit || 20) }, (_, i) => ({
                id: `conv${i + 1}`, type: 'direct', ownerId: i === 0 ? 'bob' : 'alice',
            }));
        },
        // The audit row and its live event, one transaction (projects/changeFeed).
        recordActivityEvent: async (projectId, entry) => {
            record('activity', { projectId, action: entry.action, targetType: entry.targetType, targetId: entry.targetId });
            return null;
        },
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
        countProjectNotebooks: countOf('notebooks'),
        detachNotebookFromProject: async (id, from, userId = null) => {
            record('detachNotebookFromProject', { id, from, userId });
            return userId === null ? !!fx.notebookOwners[id] : fx.notebookOwners[id] === userId;
        },
    },
    // Documents and meeting notes (projects/membership.js): doubles, so the
    // listing and the delete-time detacher never reach a real database.
    '../stores/documentStore': {
        listProjectDocuments: async (projectId) => {
            if (fx.failList === 'documents') throw new Error('document store down');
            record('listDocuments', { projectId });
            return [{ id: 'doc1', name: 'Brief', userId: 'alice' }];
        },
        countProjectDocuments: countOf('documents'),
        setDocumentProject: async (id, userId, projectId) => {
            record('setDocumentProject', { id, userId, projectId });
            return fx.documentOwners[id] === userId;
        },
        detachDocumentFromProject: async (id, from, userId) => {
            record('detachDocumentFromProject', { id, from, userId });
            return userId === null ? !!fx.documentOwners[id] : fx.documentOwners[id] === userId;
        },
        clearProjectFromDocuments: async (projectId) => { record('clearDocuments', { projectId }); return 7; },
    },
    '../stores/transcriptionStore': {
        listProjectMeetings: async (projectId) => {
            if (fx.failList === 'meetings') throw new Error('meeting store down');
            record('listMeetings', { projectId });
            return [{ id: 'mt1', title: 'Kick-off', userId: 'alice' }];
        },
        countProjectMeetings: countOf('meetings'),
        setTranscriptionProject: async (id, userId, projectId) => {
            record('setTranscriptionProject', { id, userId, projectId });
            return fx.meetingOwners[id] === userId;
        },
        detachTranscriptionFromProject: async (id, from, userId) => {
            record('detachTranscriptionFromProject', { id, from, userId });
            return userId === null ? !!fx.meetingOwners[id] : fx.meetingOwners[id] === userId;
        },
        clearProjectFromTranscriptions: async (projectId) => { record('clearMeetings', { projectId }); return 8; },
    },
    // The project's files base goes with the project (DELETE /:id).
    '../projects/projectFiles': {
        listFiles: async () => ({ files: fx.files, kbId: fx.files.length ? 'kb_files' : null }),
        // The real naming is proven in projects/projectFiles.test.js; this
        // double says which page the route handed it, and names file rows.
        nameFileActivity: async (project, items) => {
            record('nameFileActivity', { projectId: project.id, ids: items.map(i => i.id) });
            return items.map(i => (i.action === 'file.added' ? { ...i, details: { ...i.details, name: 'plan.pdf' } } : i));
        },
        removeFilesKb: async (project) => {
            fx.filesKbRemoved.push(project);
            if (fx.filesKbRemoveFails) throw new Error('knowledge base store down');
            return true;
        },
    },
    '../stores/automationStore': {
        getAutomationsForProject: async (projectId) => {
            if (fx.failList === 'automations') throw new Error('automation store down');
            record('listAutomations', { projectId });
            return [{ id: 'a1', title: 'Nightly' }];
        },
        getAutomation: async (id) => fx.automations[id] || null,
        countAutomationsForProject: countOf('automations'),
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
        countProjectApps: countOf('apps'),
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
        countProjectWebpages: countOf('webpages'),
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
        countDatatablesForProject: countOf('datatables'),
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
        countProjectAgents: countOf('agents'),
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
    // Co-editing state, comment threads and compliance signal of an item that
    // leaves (core/projectContent/itemLifecycle.js, tested on its own).
    '../core/projectContent/itemLifecycle': {
        beforeMove: async ({ kind, id, targetProjectId }) => { record('beforeMove', { kind, id, targetProjectId }); return fx.placement || null; },
        leftProject: async (kind, id, projectId) => { record('leftProject', { kind, id, projectId }); },
        beforeProjectDeleted: async (projectId) => { record('foldBackProject', { projectId }); return 0; },
    },
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
const membership = require('../projects/membership');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
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
    fx.sharedThreads = 0;
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
    fx.documentOwners = { doc1: 'alice' };
    fx.meetingOwners = { mt1: 'alice' };
    fx.filesKbRemoved = [];
    fx.filesKbRemoveFails = false;
    fx.counts = {};
    fx.chatHoldings = { conversations: 0, teamChats: 0 };
    fx.files = [];
    fx.activity = [];
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
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            // A thrown HttpError answers the way the app answers it.
            return terminalErrorHandler(err, req, res, () => reject(err));
        });
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

test('detaching is scoped to this project and to the owner', async () => {
    resetFx();
    await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'notebook', id: 'nb1', attach: false }, session: ALICE,
    });
    const call = fx.calls.find(c => c.name === 'detachNotebookFromProject');
    assert.deepStrictEqual(call.args, { id: 'nb1', from: 'p1', userId: 'alice' });
    assert.ok(!fx.calls.some(c => c.name === 'setNotebookProject'), 'never the unscoped clear');
});

test('filing in and out is ONE feed entry each, and what belonged to the project goes with the item', async () => {
    resetFx();
    fx.notebookOwners = { nb1: 'alice' };
    await dispatch({ method: 'PUT', url: '/p1/resources', body: { kind: 'notebook', id: 'nb1', attach: true }, session: ALICE });
    await dispatch({ method: 'PUT', url: '/p1/resources', body: { kind: 'notebook', id: 'nb1', attach: false }, session: ALICE });
    const seen = fx.calls.filter(c => ['beforeMove', 'setNotebookProject', 'detachNotebookFromProject', 'activity', 'leftProject'].includes(c.name))
        .map(c => [c.name, c.args.action || c.args.targetProjectId || c.args.projectId || c.args.from || null]);
    assert.deepStrictEqual(seen, [
        ['beforeMove', 'p1'], ['setNotebookProject', 'p1'], ['activity', 'content.moved_in'],
        ['beforeMove', null], ['detachNotebookFromProject', 'p1'], ['activity', 'content.moved_out'], ['leftProject', 'p1'],
    ]);
    assert.ok(!fx.calls.some(c => c.name === 'activity' && c.args.action === 'resource_added'), 'never a second, resource_added entry');
});

test('a refused move records nothing and clears nothing', async () => {
    resetFx();
    fx.notebookOwners = { nb1: 'alice' };
    const res = await dispatch({ method: 'PUT', url: '/p1/resources', body: { kind: 'notebook', id: 'nb1', attach: false }, session: BOB });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!fx.calls.some(c => c.name === 'activity' || c.name === 'leftProject'));
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
    assert.ok(names.indexOf('foldBackProject') < names.indexOf('clearNotebooks'),
        'co-edited items are folded back while they are still filed in the project');
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


// ═══ Workspace or Solution: what each kind of project holds ══════════
//
// The registry (projects/membership.js) answers which sections a container
// kind shows (`sectionsFor`) and whether a resource kind may be filed into it
// (`isAllowedIn`). The route is tested against that CONTRACT, with the split
// the product decided on, so this file does not depend on how the registry
// spells it out internally.

const WORKSPACE_SECTIONS = ['notebooks', 'knowledgeBases', 'documents', 'meetings'];
const SOLUTION_SECTIONS = ['notebooks', 'automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases', 'approvals'];
const CONTAINERS = {
    notebook: ['workspace', 'solution'], knowledge_base: ['workspace', 'solution'],
    automation: ['solution'], app: ['solution'], webpage: ['solution'], datatable: ['solution'],
    agent: ['solution'], approval: ['solution'], document: ['workspace'], meeting: ['workspace'],
};

async function withRegistry(fn, { sectionsFor, isAllowedIn } = {}) {
    const saved = { sectionsFor: membership.sectionsFor, isAllowedIn: membership.isAllowedIn };
    membership.sectionsFor = sectionsFor !== undefined ? sectionsFor : (kind) => {
        if (kind === 'workspace') return WORKSPACE_SECTIONS;
        if (kind === 'solution') return SOLUTION_SECTIONS;
        return membership.listKinds().map(k => k.section);
    };
    membership.isAllowedIn = isAllowedIn !== undefined ? isAllowedIn
        : (kind, container) => (container ? (CONTAINERS[kind] || []).includes(container) : true);
    try { return await fn(); } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete membership[k]; else membership[k] = v;
        }
    }
}

test('a collaborative project lists only its own sections, and says which kind it is', async () => {
    resetFx();
    fx.role = 'viewer';
    fx.project.kind = 'workspace';
    await withRegistry(async () => {
        const res = await dispatch({ method: 'GET', url: '/p1/resources', session: BOB });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.kind, 'workspace');
        assert.strictEqual(res.body.role, 'viewer');
        assert.strictEqual(res.body.notebooks.length, 1);
        assert.strictEqual(res.body.knowledgeBases.length, 1);
        for (const section of ['automations', 'apps', 'webpages', 'datatables', 'agents', 'approvals']) {
            assert.ok(!(section in res.body), `${section} is not a section of a collaborative project`);
        }
        const names = fx.calls.map(c => c.name);
        assert.ok(!names.includes('listAutomations') && !names.includes('listApprovals'),
            'a hidden section is not read at all');
    });
});

test('a Solution lists the builder sections, not the collaboration ones', async () => {
    resetFx();
    fx.project.kind = 'solution';
    await withRegistry(async () => {
        const res = await dispatch({ method: 'GET', url: '/p1/resources', session: ALICE });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.kind, 'solution');
        assert.strictEqual(res.body.automations.length, 1);
        assert.strictEqual(res.body.apps.length, 1);
        assert.ok(!('documents' in res.body) && !('meetings' in res.body));
    });
});

test('a legacy project (kind null) lists every section until it is classified', async () => {
    resetFx();
    fx.project.kind = null;
    await withRegistry(async () => {
        const res = await dispatch({ method: 'GET', url: '/p1/resources', session: ALICE });
        assert.strictEqual(res.body.kind, null);
        for (const k of membership.listKinds()) assert.ok(k.section in res.body, k.section);
    });
});

test('a registry without the container answer keeps the listing as it was', async () => {
    resetFx();
    fx.project.kind = 'workspace';
    await withRegistry(async () => {
        const res = await dispatch({ method: 'GET', url: '/p1/resources', session: ALICE });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.automations.length, 1);
    }, { sectionsFor: null, isAllowedIn: null });
});

test('a project that is gone answers 404 for its resources', async () => {
    resetFx();
    fx.project = null;
    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: ALICE });
    assert.strictEqual(res.statusCode, 404);
});

test('filing a kind the container does not hold is a 400, and nothing moves', async () => {
    resetFx();
    fx.project.kind = 'workspace';
    await withRegistry(async () => {
        const res = await dispatch({
            method: 'PUT', url: '/p1/resources',
            body: { kind: 'app', id: 'app1', attach: true }, session: ALICE,
        });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.code, 'KIND_NOT_ALLOWED');
        assert.match(res.body.error, /Studio Solution/);
        assert.ok(!fx.calls.some(c => c.name === 'setAppProject'), 'the store was not asked');
    });

    resetFx();
    fx.project.kind = 'solution';
    await withRegistry(async () => {
        // The same kind files into the container that does hold it.
        const res = await dispatch({
            method: 'PUT', url: '/p1/resources',
            body: { kind: 'automation', id: 'a1', attach: true }, session: ALICE,
        });
        assert.strictEqual(res.statusCode, 200, 'an automation belongs in a Solution');
    });
});

test('taking a kind OUT is always allowed, so a classified project can be tidied', async () => {
    resetFx();
    fx.project.kind = 'workspace';
    await withRegistry(async () => {
        const res = await dispatch({
            method: 'PUT', url: '/p1/resources',
            body: { kind: 'app', id: 'app1', attach: false }, session: ALICE,
        });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(fx.calls.find(c => c.name === 'setAppProject').args,
            { id: 'app1', userId: 'alice', projectId: null });
    });
});

test('a notebook still files into a collaborative project', async () => {
    resetFx();
    fx.project.kind = 'workspace';
    await withRegistry(async () => {
        const res = await dispatch({
            method: 'PUT', url: '/p1/resources',
            body: { kind: 'notebook', id: 'nb1', attach: true }, session: ALICE,
        });
        assert.strictEqual(res.statusCode, 200);
    });
});

// ═══ Classifying: never hide what the project holds ══════════════════
//
// The route itself is proven with fakes in routes/projects/kind.test.js;
// these run it through the REAL registry (projects/membership.js), so the
// counts come from the kinds' own countIn functions.

test('a legacy project holding an app and a routine cannot become a workspace until they are out', async () => {
    resetFx();
    fx.role = 'owner';
    fx.project.kind = null;
    fx.counts = { apps: 1, automations: 2, notebooks: 4, documents: 3 };
    const res = await dispatch({ method: 'PUT', url: '/p1/kind', body: { kind: 'workspace' }, session: ALICE });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'KIND_HOLDS_OTHER_CONTENT');
    assert.deepStrictEqual(res.body.details, { kind: 'workspace', held: { automations: 2, apps: 1 } });
    assert.ok(!fx.calls.some(c => c.name === 'setProjectKind'), 'not classified');
    assert.ok(!fx.calls.some(c => c.name === 'activity'), 'not announced');

    // Taken out: now it may.
    fx.counts = { notebooks: 4, documents: 3 };
    const ok = await dispatch({ method: 'PUT', url: '/p1/kind', body: { kind: 'workspace' }, session: ALICE });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.kind, 'workspace');
    assert.ok(fx.calls.some(c => c.name === 'activity' && c.args.action === 'kind_set'));
});

test('a project with chats, documents or files cannot become a Solution', async () => {
    resetFx();
    fx.role = 'owner';
    fx.project.kind = 'workspace';
    fx.project.kindGuessed = true;
    fx.counts = { documents: 2, apps: 5 };
    fx.chatHoldings = { conversations: 30, teamChats: 1 };
    fx.files = [{ id: 'f1' }];
    const res = await dispatch({ method: 'PUT', url: '/p1/kind', body: { kind: 'solution' }, session: ALICE });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body.details.held, { documents: 2, conversations: 30, teamChats: 1, files: 1 });
    assert.strictEqual(fx.project.kind, 'workspace');
    assert.strictEqual(fx.project.kindGuessed, true, 'the guess can still be corrected once it is empty');
});

test('the backfill\'s guess is corrected once through the mounted route', async () => {
    resetFx();
    fx.role = 'owner';
    fx.project.kind = 'solution';
    fx.project.kindGuessed = true;
    const res = await dispatch({ method: 'PUT', url: '/p1/kind', body: { kind: 'workspace' }, session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.project.kind, 'workspace');
    const again = await dispatch({ method: 'PUT', url: '/p1/kind', body: { kind: 'solution' }, session: ALICE });
    assert.strictEqual(again.statusCode, 409);
    assert.strictEqual(again.body.code, 'KIND_ALREADY_SET');
});

// ═══ The activity feed names files when it is read ══════════════════

test('the activity page is named at read time, and only the page is handed over', async () => {
    resetFx();
    fx.role = 'viewer';
    fx.activity = [
        { id: 'a1', action: 'file.added', targetType: 'file', targetId: 'f1', details: { targetType: 'file', targetId: 'f1' } },
        { id: 'a2', action: 'member_added', details: {} },
        { id: 'a3', action: 'file.removed', details: {} },
    ];
    const res = await dispatch({ method: 'GET', url: '/p1/activity?limit=2', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.hasMore, true);
    assert.deepStrictEqual(res.body.items.map(i => i.id), ['a1', 'a2']);
    assert.strictEqual(res.body.items[0].details.name, 'plan.pdf');
    const naming = fx.calls.filter(c => c.name === 'nameFileActivity');
    assert.deepStrictEqual(naming.map(c => c.args), [{ projectId: 'p1', ids: ['a1', 'a2'] }], 'not the look-ahead row');
});

// ═══ Deleting a project with shared chats ════════════════════════════

test('a project with shared chats is not deleted: 409, and nothing is detached', async () => {
    resetFx();
    fx.role = 'owner';
    fx.sharedThreads = 2;

    const res = await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'SHARED_CHATS_REMAIN');
    assert.match(res.body.error, /The 2 chats shared with this project must be made private first, by the people who shared them/);
    // Which chats and whose: only a chat's own owner can unshare it, so the
    // page can say whom to ask (ids only; the member list names people).
    assert.deepStrictEqual(res.body.details, {
        sharedChats: 2,
        chats: [{ id: 'conv1', type: 'direct', ownerId: 'bob' }, { id: 'conv2', type: 'direct', ownerId: 'alice' }],
    });
    assert.strictEqual(fx.deleted, false);
    assert.ok(!fx.calls.some(c => /^clear/.test(c.name)), 'a refused delete leaves every resource filed');
});

test('a chat shared in the moment before the delete is still a 409, not a 500', async () => {
    resetFx();
    fx.role = 'owner';
    const original = MOCKS['../stores/projectStore'].deleteProject;
    let counted = 0;
    MOCKS['../stores/projectStore'].countSharedThreads = async () => (counted++ === 0 ? 0 : 1);
    MOCKS['../stores/projectStore'].deleteProject = async () => {
        throw Object.assign(new Error('new row violates check constraint'), {
            code: '23514', constraint: 'direct_conversations_shared_needs_project',
        });
    };
    try {
        const res = await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
        assert.strictEqual(res.statusCode, 409);
        assert.strictEqual(res.body.code, 'SHARED_CHATS_REMAIN');
        assert.match(res.body.error, /The 1 chat shared with this project must be made private first, by the person who shared it/);
    } finally {
        MOCKS['../stores/projectStore'].deleteProject = original;
        MOCKS['../stores/projectStore'].countSharedThreads = async () => fx.sharedThreads;
    }
});

test('any other delete failure stays a generic 500', async () => {
    resetFx();
    fx.role = 'owner';
    const original = MOCKS['../stores/projectStore'].deleteProject;
    MOCKS['../stores/projectStore'].deleteProject = async () => {
        throw Object.assign(new Error('relation "projects" does not exist'), { code: '42P01' });
    };
    try {
        const res = await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body.error, 'Internal server error');
        assert.ok(!/does not exist|42P01/.test(JSON.stringify(res.body)), 'no SQL text in the response');
    } finally {
        MOCKS['../stores/projectStore'].deleteProject = original;
    }
});

test('only the owner may try: an editor gets 403 and a stranger 404', async () => {
    resetFx();
    fx.role = 'editor';
    assert.strictEqual((await dispatch({ method: 'DELETE', url: '/p1', session: BOB })).statusCode, 403);
    fx.role = null;
    assert.strictEqual((await dispatch({ method: 'DELETE', url: '/p1', session: BOB })).statusCode, 404);
    assert.strictEqual(fx.deleted, false);
});

test('with the registry\'s own table, a collaborative project never lists builder sections', async () => {
    // No stand-in here: projects/membership.js answers for itself.
    resetFx();
    fx.project.kind = 'workspace';
    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.notebooks.length, 1);
    for (const section of ['automations', 'apps', 'webpages', 'datatables', 'approvals']) {
        assert.ok(!(section in res.body), `${section} is not a section of a collaborative project`);
    }

    resetFx();
    fx.project.kind = 'workspace';
    const filing = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'automation', id: 'a1', attach: true }, session: ALICE,
    });
    assert.strictEqual(filing.statusCode, 400);
    assert.strictEqual(filing.body.code, 'KIND_NOT_ALLOWED');
});

// ═══ The project's own files base ════════════════════════════════════
//
// Every collaborative project gets ONE knowledge base for the files uploaded
// into it (projects/projectFiles.js), recorded as `filesKbId` and listed in
// `knowledgeBaseIds` so the chats search it. It is owned by the project owner
// and never published, so for everybody else the ordinary "may I read this
// base" answer is no. That must not turn into a way to break it: it is not a
// LINKED base, so it is neither listed nor unlinked as one, a settings save by
// an editor never trips over it and never drops it, and it goes with the
// project.

function withFilesKb() {
    fx.project.kind = 'workspace';
    fx.project.filesKbId = 'kb_files';
    fx.project.knowledgeBaseIds = ['kb_files', 'kb1'];
    fx.kbs.kb_files = { id: 'kb_files', name: 'P · Files', organization_id: 'org1', source_kind: 'project_files' };
    // Only the project owner can read it the ordinary way.
    fx.readableKBs = ['kb1', 'kb2'];
}

test('the files base is not listed among the linked knowledge bases', async () => {
    resetFx();
    withFilesKb();
    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.knowledgeBases.map(k => k.id), ['kb1']);
    assert.ok(!fx.calls.some(c => c.name === 'getKB' && c.args.id === 'kb_files'), 'not even read');
});

test('the files base cannot be unlinked through the resources route', async () => {
    resetFx();
    withFilesKb();
    fx.role = 'owner';
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'knowledge_base', id: 'kb_files', attach: false }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'PROJECT_FILES_KB');
    assert.deepStrictEqual(fx.project.knowledgeBaseIds, ['kb_files', 'kb1'], 'nothing written');
    assert.ok(!fx.calls.some(c => c.name === 'updateProject'));
});

test('another project\'s files base cannot be linked, even by the person who owns both', async () => {
    resetFx();
    withFilesKb();
    fx.kbs.kb_other_files = { id: 'kb_other_files', name: 'Q · Files', organization_id: 'org1', source_kind: 'project_files' };
    fx.readableKBs.push('kb_other_files');
    const res = await dispatch({
        method: 'PUT', url: '/p1/resources',
        body: { kind: 'knowledge_base', id: 'kb_other_files', attach: true }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!fx.calls.some(c => c.name === 'updateProject'));
});

test('an editor saving the settings form keeps the files base without being able to read it', async () => {
    resetFx();
    withFilesKb();
    // The form sends back what it was given, files base included.
    const res = await dispatch({
        method: 'PUT', url: '/p1', body: { knowledgeBaseIds: ['kb_files', 'kb1', 'kb2'] }, session: BOB,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.project.knowledgeBaseIds, ['kb_files', 'kb1', 'kb2']);
});

test('a settings save that leaves the files base out does not drop it', async () => {
    resetFx();
    withFilesKb();
    const res = await dispatch({ method: 'PUT', url: '/p1', body: { knowledgeBaseIds: ['kb2'] }, session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.project.knowledgeBaseIds, ['kb_files', 'kb2']);
});

test('a settings save still refuses another project\'s files base', async () => {
    resetFx();
    withFilesKb();
    fx.kbs.kb_other_files = { id: 'kb_other_files', name: 'Q · Files', organization_id: 'org1', source_kind: 'project_files' };
    fx.readableKBs.push('kb_other_files');
    const res = await dispatch({
        method: 'PUT', url: '/p1', body: { knowledgeBaseIds: ['kb1', 'kb_other_files'] }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body.invalid, ['kb_other_files']);
    assert.deepStrictEqual(fx.project.knowledgeBaseIds, ['kb_files', 'kb1'], 'nothing written');
});

test('the cap counts the files base', async () => {
    resetFx();
    withFilesKb();
    const many = Array.from({ length: 50 }, (_, i) => `kb_${i}`);
    const res = await dispatch({ method: 'PUT', url: '/p1', body: { knowledgeBaseIds: many }, session: ALICE });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /At most 50/);
});

test('deleting a project removes its files base, after the delete went through', async () => {
    resetFx();
    withFilesKb();
    fx.role = 'owner';
    const res = await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.deleted, true);
    assert.strictEqual(fx.filesKbRemoved.length, 1);
    assert.strictEqual(fx.filesKbRemoved[0].filesKbId, 'kb_files');
});

test('a files base that cannot be removed does not fail the delete', async () => {
    resetFx();
    withFilesKb();
    fx.role = 'owner';
    fx.filesKbRemoveFails = true;
    const res = await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true });
});

test('a refused delete keeps the files base', async () => {
    resetFx();
    withFilesKb();
    fx.role = 'owner';
    fx.sharedThreads = 1;
    const res = await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(fx.filesKbRemoved.length, 0);
});

test('a project without a files base deletes without touching the files module', async () => {
    resetFx();
    fx.role = 'owner';
    await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
    assert.strictEqual(fx.deleted, true);
    assert.strictEqual(fx.filesKbRemoved.length, 0);
});

// ═══ Documents and meeting notes ═════════════════════════════════════

test('a collaborative project lists its documents and meeting notes', async () => {
    resetFx();
    fx.role = 'viewer';
    fx.project.kind = 'workspace';
    const res = await dispatch({ method: 'GET', url: '/p1/resources', session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.documents.map(d => d.id), ['doc1']);
    assert.deepStrictEqual(res.body.meetings.map(m => m.id), ['mt1']);
});

test('the project owner may take a colleague\'s document out; an editor may not', async () => {
    resetFx();
    fx.project.kind = 'workspace';
    fx.documentOwners = { doc1: 'carol' };

    fx.role = 'editor';
    const editor = await dispatch({
        method: 'PUT', url: '/p1/resources', body: { kind: 'document', id: 'doc1', attach: false }, session: BOB,
    });
    assert.strictEqual(editor.statusCode, 404);

    fx.role = 'owner';
    const owner = await dispatch({
        method: 'PUT', url: '/p1/resources', body: { kind: 'document', id: 'doc1', attach: false }, session: ALICE,
    });
    assert.strictEqual(owner.statusCode, 200);
    const scoped = fx.calls.filter(c => c.name === 'detachDocumentFromProject').pop();
    assert.deepStrictEqual(scoped.args, { id: 'doc1', from: 'p1', userId: null }, 'only out of THIS project');
});

test('deleting a project detaches its documents and meeting notes', async () => {
    resetFx();
    fx.role = 'owner';
    await dispatch({ method: 'DELETE', url: '/p1', session: ALICE });
    const names = fx.calls.map(c => c.name);
    assert.ok(names.includes('clearDocuments'));
    assert.ok(names.includes('clearMeetings'));
});
