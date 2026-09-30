'use strict';

/**
 * The project content routes (routes/projects/content.js): a new document or
 * notebook made inside a project.
 *
 * The factory router is served with injected fakes behind a real express app
 * and the real terminal error handler (core/http/routeHarness.js `serve`): no
 * module mocking and no database. The role fake answers like
 * auth/projectAccess.requireProjectRole: 401 without a session, 404 for
 * somebody who is not a member, 403 for a role that is too low.
 *
 * Proven, per route: the happy path (owned by the caller, filed in the project,
 * ONE "content.created" entry: the audit row and its live event, written by
 * the real projects/changeFeed over a recording store), and every refusal (no session, not a
 * member, a viewer, a Studio Solution, another organisation, a closed schema,
 * a store refusal) — and that a refused request creates nothing and announces
 * nothing.
 *
 * Run: cd server && node --test routes/projects/content.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { serve, assertRefused } = require('../../core/http/routeHarness');
const membership = require('../../projects/membership');
const { makeContentRouter } = require('./content');
const { makeChangeFeed } = require('../../projects/changeFeed');
const { makeNotebookGate } = require('./notebookGate');

const OWNER = { id: 'u_owner', organizationId: 'org1' };
const EDITOR = { id: 'u_editor', organizationId: 'org1' };
const VIEWER = { id: 'u_viewer', organizationId: 'org1' };
const STRANGER = { id: 'u_stranger', organizationId: 'org1' };
const FOREIGN_EDITOR = { id: 'u_foreign', organizationId: 'org2' };

const ROLES = {
    p1: { u_owner: 'owner', u_editor: 'editor', u_viewer: 'viewer', u_foreign: 'editor' },
    legacy: { u_owner: 'owner', u_editor: 'editor' },
    sol: { u_owner: 'owner', u_editor: 'editor' },
    gone: { u_editor: 'editor' },
};
const PROJECTS = {
    p1: { id: 'p1', name: 'Launch', kind: 'workspace', ownerId: 'u_owner', organizationId: 'org1' },
    legacy: { id: 'legacy', name: 'Old', kind: null, ownerId: 'u_owner', organizationId: 'org1' },
    sol: { id: 'sol', name: 'Invoices', kind: 'solution', ownerId: 'u_owner', organizationId: 'org1' },
    // `gone` has a role row but the project vanished between gate and handler.
};
const USERS = {
    u_owner: { id: 'u_owner', organizationId: 'org1' },
    u_editor: { id: 'u_editor', organizationId: 'org1' },
    u_viewer: { id: 'u_viewer', organizationId: 'org1' },
    u_foreign: { id: 'u_foreign', organizationId: 'org2' },
};
const ORDER = { viewer: 0, editor: 1, owner: 2 };

// ── Recording fakes ───────────────────────────────────────────────────
const rec = { documents: [], notebooks: [], activity: [], events: [], limited: 0, notebookGateRuns: 0 };
let storeRefusal = null;
let activityFails = false;
// What the notebooks gates answer (module, capability, feature switch,
// use_notebooks): null lets the caller through, a status refuses as the real
// gate would, by writing a response.
let notebooksRefusal = null;
const reset = () => {
    for (const k of ['documents', 'notebooks', 'activity', 'events']) rec[k].length = 0;
    rec.limited = 0;
    storeRefusal = null;
    activityFails = false;
    notebooksRefusal = null;
    rec.notebookGateRuns = 0;
};

const STARTERS = [
    { id: 'letter', name: 'Letter', docType: 'letter', kind: 'template', description: 'A letter',
        bodyHtml: '<h1>Letter</h1>', css: '.l{}', settings: { contract: { parameters: [] } } },
];

const router = makeContentRouter({
    requireProjectRole: (minRole) => function requireProjectRoleMw(req, res, next) {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const role = ROLES[req.params.id]?.[userId];
        if (!role) return res.status(404).json({ error: 'Not found' });
        if (ORDER[role] < ORDER[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
        req.projectRole = role;
        next();
    },
    getProject: async (id) => PROJECTS[id] || null,
    getUser: async (id) => USERS[id] || null,
    documents: {
        async createDocument(input) {
            if (storeRefusal) throw storeRefusal;
            rec.documents.push(input);
            return { id: 'doc-1', userId: input.userId, name: input.name, docType: input.docType || 'document',
                kind: input.kind, projectId: input.projectId, bodyHtml: input.bodyHtml || '', css: input.css || '' };
        },
    },
    notebooks: {
        async createNotebook(input) {
            rec.notebooks.push(input);
            return { id: 'nb-1', userId: input.userId, name: input.name, description: input.description,
                projectId: input.projectId, organizationId: input.organizationId };
        },
    },
    starters: () => STARTERS,
    membership,
    // The real change feed over a store that records what the one transaction
    // would write: the activity row, and the event that goes with it.
    changeFeed: makeChangeFeed({
        store: {
            async recordActivityEvent(projectId, entry) {
                if (activityFails) throw new Error('activity table is down');
                rec.activity.push({ projectId, actorId: entry.actorId, action: entry.action, details: entry.details });
                return { activityId: 'a1', event: { seq: 1, kind: entry.action, actorId: entry.actorId, targetType: entry.targetType, targetId: entry.targetId, payload: entry.details } };
            },
        },
        publish: async (projectId, event) => { rec.events.push({ projectId, ...event }); },
        log: { error() {}, warn() {}, info() {} },
    }),
    createLimiter: function rateLimitMiddleware(req, res, next) { rec.limited += 1; next(); },
    requireNotebooks: makeNotebookGate({
        gates: [function notebooksGates(req, res, next) {
            rec.notebookGateRuns += 1;
            if (!notebooksRefusal) return next();
            if (notebooksRefusal === 503) res.set('Retry-After', '1');
            return res.status(notebooksRefusal).json({ error: 'refused' });
        }],
    }),
    log: { error() {}, warn() {}, info() {} },
});

const api = serve('/api/projects', router, { user: EDITOR });
test.after(api.close);

const nothingHappened = () => {
    assert.deepStrictEqual(rec.documents, [], 'no document was created');
    assert.deepStrictEqual(rec.notebooks, [], 'no notebook was created');
    assert.deepStrictEqual(rec.activity, [], 'no activity row');
    assert.deepStrictEqual(rec.events, [], 'no live event');
};

// ═══ POST /:id/documents ═════════════════════════════════════════════

test('an editor creates a document: theirs, private, filed in the project, announced', async () => {
    reset();
    const res = await api.call('POST', '/api/projects/p1/documents', { body: { name: '  Launch plan  ', docType: 'report' } });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body.document.id, 'doc-1');
    assert.strictEqual(res.body.document.projectId, 'p1');
    assert.deepStrictEqual(rec.documents, [{
        userId: 'u_editor', name: 'Launch plan', docType: 'report', description: undefined,
        bodyHtml: undefined, css: undefined, settings: undefined, kind: 'document', visibility: 'private', projectId: 'p1',
    }]);
    // One "created" entry, not a `resource_added` next to it: the document was
    // made here, and "since your last visit" must count it once.
    assert.deepStrictEqual(rec.activity, [{ projectId: 'p1', actorId: 'u_editor', action: 'content.created',
        details: { itemType: 'document', itemId: 'doc-1', targetType: 'document', targetId: 'doc-1' } }]);
    assert.strictEqual(rec.events.length, 1);
    assert.strictEqual(rec.events[0].kind, 'content.created');
    assert.strictEqual(rec.events[0].targetType, 'document');
    assert.strictEqual(rec.events[0].targetId, 'doc-1');
    assert.strictEqual(rec.events[0].actorId, 'u_editor');
    assert.ok(!JSON.stringify(rec.events).includes('Launch plan'), 'the event names ids, not content');
    assert.strictEqual(rec.limited, 1, 'the create passed the rate limit');
});

test('a starter fills the document, but it is made as a plain document, not a template', async () => {
    reset();
    const res = await api.call('POST', '/api/projects/p1/documents', { body: { name: 'To the board', starterId: 'letter', locale: 'en' } });
    assert.strictEqual(res.status, 201, res.text);
    const made = rec.documents[0];
    assert.strictEqual(made.bodyHtml, '<h1>Letter</h1>');
    assert.strictEqual(made.docType, 'letter', 'the starter\'s type when none is asked for');
    assert.strictEqual(made.kind, 'document');
    assert.strictEqual(made.name, 'To the board', 'the name asked for, not the starter\'s');
});

test('the project owner, and a legacy project that is not classified yet, can hold documents', async () => {
    reset();
    assert.strictEqual((await api.call('POST', '/api/projects/p1/documents', { body: { name: 'A' }, user: OWNER })).status, 201);
    assert.strictEqual((await api.call('POST', '/api/projects/legacy/documents', { body: { name: 'B' } })).status, 201);
    assert.deepStrictEqual(rec.documents.map(d => d.projectId), ['p1', 'legacy']);
});

test('documents: no session 401, a stranger 404, a viewer 403, and nothing is made', async () => {
    reset();
    assert.strictEqual((await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x' }, user: null })).status, 401);
    assert.strictEqual((await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x' }, user: STRANGER })).status, 404);
    assert.strictEqual((await api.call('POST', '/api/projects/nope/documents', { body: { name: 'x' } })).status, 404);
    const viewer = await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x' }, user: VIEWER });
    assert.strictEqual(viewer.status, 403);
    nothingHappened();
});

test('a Studio Solution holds no documents: 409, and nothing is made', async () => {
    reset();
    const res = await api.call('POST', '/api/projects/sol/documents', { body: { name: 'x' } });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'KIND_NOT_ALLOWED');
    assert.match(res.body.error, /Solution/);
    nothingHappened();
});

test('a member from another organisation cannot make content in this one', async () => {
    reset();
    const res = await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x' }, user: FOREIGN_EDITOR });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'project_org_mismatch');
    nothingHappened();
});

test('a project that vanished after the role check is a 404', async () => {
    reset();
    const res = await api.call('POST', '/api/projects/gone/documents', { body: { name: 'x' } });
    assert.strictEqual(res.status, 404);
    nothingHappened();
});

test('documents: the body is closed and every refusal is a sentence', async () => {
    reset();
    assertRefused(assert, await api.call('POST', '/api/projects/p1/documents', { body: {} }), 'body.name', /name is the title/);
    assertRefused(assert, await api.call('POST', '/api/projects/p1/documents', { body: { name: '   ' } }), 'body.name');
    assertRefused(assert, await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x'.repeat(201) } }), 'body.name');
    assertRefused(assert, await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x', docType: 'invoce' } }), 'body.docType', /docType is a document type/);
    assertRefused(assert, await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x', projectId: 'other' } }), null, /does not take "projectId"/);
    assertRefused(assert, await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x', kind: 'template' } }), null, /does not take "kind"/);
    const unknownStarter = await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x', starterId: 'nope' } });
    assert.strictEqual(unknownStarter.status, 400);
    assert.strictEqual(unknownStarter.body.code, 'unknown_starter');
    nothingHappened();
});

test('a refusal the store states on purpose reaches the client with its status; anything else is a 500', async () => {
    reset();
    storeRefusal = Object.assign(new Error('This project belongs to another organization'), { status: 409, errorClass: 'project_org_mismatch' });
    const refused = await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x' } });
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.body.code, 'project_org_mismatch');

    storeRefusal = new Error('duplicate key value violates unique constraint "studio_documents_pkey"');
    const failed = await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x' } });
    assert.strictEqual(failed.status, 500);
    assert.ok(!failed.text.includes('studio_documents_pkey'), 'no SQL detail reaches the client');
    assert.deepStrictEqual(rec.activity, []);
    assert.deepStrictEqual(rec.events, []);
});

test('a feed that fails after the create still answers 201, and announces nothing it did not record', async () => {
    reset();
    activityFails = true;
    const res = await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x' } });
    assert.strictEqual(res.status, 201, 'a retry would create a second document');
    // The audit row and the live event are now one transaction
    // (projects/changeFeed): an event nobody can find in the activity log is
    // exactly what that rules out, so a failed write sends neither.
    assert.deepStrictEqual(rec.events, []);
});

// ═══ POST /:id/notebooks ═════════════════════════════════════════════

test('an editor creates a notebook: theirs, filed in the project, stamped with their organisation', async () => {
    reset();
    const res = await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'Research', description: 'Sources for the launch' } });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body.notebook.id, 'nb-1');
    assert.deepStrictEqual(rec.notebooks, [{
        userId: 'u_editor', name: 'Research', description: 'Sources for the launch', projectId: 'p1', organizationId: 'org1',
    }]);
    assert.deepStrictEqual(rec.activity.map(a => [a.action, a.details]),
        [['content.created', { itemType: 'notebook', itemId: 'nb-1', targetType: 'notebook', targetId: 'nb-1' }]]);
    assert.strictEqual(rec.events[0].targetType, 'notebook');
});

test('a notebook may live in a Solution too, and in a legacy project', async () => {
    reset();
    assert.strictEqual((await api.call('POST', '/api/projects/sol/notebooks', { body: { name: 'N' } })).status, 201);
    assert.strictEqual((await api.call('POST', '/api/projects/legacy/notebooks', { body: { name: 'N' } })).status, 201);
    assert.deepStrictEqual(rec.notebooks.map(n => n.projectId), ['sol', 'legacy']);
});

test('notebooks: no session 401, a stranger 404, a viewer 403, another organisation 409', async () => {
    reset();
    assert.strictEqual((await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x' }, user: null })).status, 401);
    assert.strictEqual((await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x' }, user: STRANGER })).status, 404);
    assert.strictEqual((await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x' }, user: VIEWER })).status, 403);
    assert.strictEqual((await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x' }, user: FOREIGN_EDITOR })).status, 409);
    nothingHappened();
});

test('notebooks: a caller the notebooks gates refuse gets 403 notebooks_unavailable, and nothing is made', async () => {
    // The module off (its own 404), not in the plan or switched off (403), or
    // a role without use_notebooks (403): the project cannot be the way round
    // the gates that /api/notebooks, the only way to open it, applies.
    for (const status of [404, 403]) {
        reset();
        notebooksRefusal = status;
        const res = await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x' } });
        assert.strictEqual(res.status, 403, `a ${status} from the gates`);
        assert.strictEqual(res.body.code, 'notebooks_unavailable');
        assert.match(res.body.error, /not available/);
        assert.strictEqual(rec.limited, 0, 'refused before the rate limit counts it');
        nothingHappened();
    }
});

test('notebooks: gates that cannot tell answer 503 notebooks_unknown with their Retry-After', async () => {
    reset();
    notebooksRefusal = 503;
    const res = await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x' } });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.code, 'notebooks_unknown');
    assert.strictEqual(res.headers.get('retry-after'), '1');
    nothingHappened();
});

test('notebooks: the role gate runs first, so a stranger still reads 404 and a viewer 403', async () => {
    reset();
    notebooksRefusal = 403;
    assert.strictEqual((await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x' }, user: STRANGER })).status, 404);
    assert.strictEqual((await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x' }, user: VIEWER })).status, 403);
    assert.strictEqual(rec.notebookGateRuns, 0, 'the notebooks gates never ran for a non-editor');
});

test('documents do not pass the notebooks gates', async () => {
    reset();
    notebooksRefusal = 403;
    assert.strictEqual((await api.call('POST', '/api/projects/p1/documents', { body: { name: 'x' } })).status, 201);
    assert.strictEqual(rec.notebookGateRuns, 0);
});

test('notebooks: the body is closed and every refusal is a sentence', async () => {
    reset();
    assertRefused(assert, await api.call('POST', '/api/projects/p1/notebooks', { body: { description: 'x' } }), 'body.name');
    assertRefused(assert, await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x', description: 'd'.repeat(1001) } }), 'body.description', /description is text/);
    assertRefused(assert, await api.call('POST', '/api/projects/p1/notebooks', { body: { name: 'x', instructions: 'be nice' } }), null, /does not take "instructions"/);
    nothingHappened();
});

test('every route starts with the named role gate', () => {
    for (const layer of router.stack) {
        if (!layer.route) continue;
        const names = layer.route.stack.map(l => l.name);
        assert.strictEqual(names[0], 'requireProjectRoleMw', `${layer.route.path} starts with the role gate`);
        assert.ok(names.includes('validateRequest'), `${layer.route.path} validates its body`);
        if (layer.route.path === '/:id/notebooks') assert.strictEqual(names[1], 'requireNotebooksMw', 'the notebooks gates come right after the role gate');
    }
});
