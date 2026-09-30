/**
 * Who may do what with a notebook (routes/notebooks.js, routes/notebooksAccess.js):
 * the role matrix, the compare-and-set conflict that keeps the losing copy,
 * and the whole-document write that refuses while the notebook is co-edited.
 *
 *   owner   alice — the notebook is hers
 *   editor  erin  — project editor
 *   viewer  vic   — project viewer
 *   owner of the PROJECT, not of the notebook: olga — edits like an editor
 *   stranger mallory — 404 everywhere, the notebook is not probeable
 *
 * Before this, a viewer could delete version history, add and delete sources,
 * generate and fill; a project editor who lost a save race got a 404 and a
 * page stuck on "Save failed — retry"; a stale save silently discarded the
 * local text.
 *
 * The store is swapped on its shared module object (testUtils/swaps.js), the
 * database only records (core/http/routeHarness.js): no module mocking.
 *
 * Run: cd server && node --test routes/notebooks.roles.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');
const { makeSwaps } = require('../testUtils/swaps');

const notebookStore = require('../stores/notebookStore');
const notebookCascade = require('../core/kb/notebookCascade');
const notebookConversationStore = require('../stores/notebookConversationStore');

const { swap, restore } = makeSwaps();

const USERS = {
    alice: { id: 'alice', organizationId: 'org1', role: 'user' },
    erin: { id: 'erin', organizationId: 'org1', role: 'user' },
    vic: { id: 'vic', organizationId: 'org1', role: 'user' },
    olga: { id: 'olga', organizationId: 'org1', role: 'user' },
    mallory: { id: 'mallory', organizationId: 'org2', role: 'user' },
};
const PROJECT_ROLES = { erin: 'editor', vic: 'viewer', olga: 'owner' };

const state = {
    notebook: null,
    sources: [],
    versions: [],
    feed: [],
    collabActive: false,
    // A colleague opened it live between the route's check and the store's write.
    coEditedAtWrite: false,
    deleted: [],
};

function reset() {
    state.notebook = {
        id: 'nb1', userId: 'alice', name: 'Research', projectId: 'p1', organizationId: 'org1',
        documentContent: '<p>Hello</p>', documentMd: 'Hello', version: 3, knowledgeBaseIds: [],
        lastEditedBy: 'alice', lastEditedAt: null, updatedAt: '2026-09-01T00:00:00.000Z',
    };
    state.sources = [{ id: 's1', notebookId: 'nb1', name: 'Notes', type: 'text', status: 'ready' }];
    state.versions = [];
    state.feed = [];
    state.collabActive = false;
    state.coEditedAtWrite = false;
    state.deleted = [];
}

/** The store's own role rule, over the fixture. */
function roleOf(userId) {
    if (userId === state.notebook.userId) return 'owner';
    if (!state.notebook.projectId) return null;
    return notebookStore.notebookRoleForProjectRole(PROJECT_ROLES[userId] || null);
}

const { api } = h.routeUnderTest(test, '/api/notebooks', () => {
    const router = require('./notebooks');
    swap(router.seams, 'collab', () => ({ isActive: async () => state.collabActive }));
    swap(router.seams, 'feed', () => ({
        contentChanged: async (e) => { state.feed.push({ kind: 'content', ...e }); },
        renamed: async (e) => { state.feed.push({ kind: 'renamed', ...e }); },
        sourcesAdded: async (e) => { state.feed.push({ kind: 'sources', ...e }); },
    }));
    swap(router.seams, 'getProject', async (id) => (id === 'p1' ? { id: 'p1', name: 'Launch', kind: 'workspace', color: '#0a0', icon: 'x' } : null));
    swap(router.seams, 'projectRoleOf', async (userId) => (userId === 'alice' ? 'editor' : PROJECT_ROLES[userId] || null));
    return router;
});

test.before(() => {
    reset();
    swap(notebookStore, 'getNotebook', async (id, userId) => {
        if (id !== state.notebook.id) return null;
        const role = roleOf(userId);
        if (!role) return null;
        return role === 'owner' ? { ...state.notebook, role } : { ...state.notebook, role, projectRole: PROJECT_ROLES[userId] };
    });
    swap(notebookStore, 'updateNotebookCas', async (id, userId, updates) => {
        const role = roleOf(userId);
        if (role !== 'owner' && role !== 'editor') return { ok: false, conflict: false };
        if (state.coEditedAtWrite && updates.documentContent !== undefined) return { ok: false, conflict: true, coEdited: true };
        if (typeof updates.expectedVersion === 'number' && updates.expectedVersion !== state.notebook.version) {
            return { ok: false, conflict: true, currentVersion: state.notebook.version };
        }
        if (updates.documentContent !== undefined) {
            state.notebook.documentContent = updates.documentContent;
            state.notebook.version += 1;
        }
        if (updates.name !== undefined) state.notebook.name = updates.name;
        if (updates.pinned !== undefined) state.notebook.pinned = updates.pinned;
        return { ok: true, conflict: false, version: state.notebook.version };
    });
    swap(notebookStore, 'shouldAutoVersion', async () => true);
    swap(notebookStore, 'recordVersion', async (notebookId, v) => {
        const row = { id: `v${state.versions.length + 1}`, notebookId, deduped: false, ...v };
        state.versions.push(row);
        return row;
    });
    swap(notebookStore, 'getSources', async () => state.sources.map((x) => ({ ...x })));
    swap(notebookStore, 'timeoutStuckSources', async () => 0);
    swap(notebookStore, 'getSource', async (sid) => state.sources.find((x) => x.id === sid) || null);
    swap(notebookStore, 'updateSource', async () => true);
    swap(notebookStore, 'reorderSources', async () => true);
    swap(notebookStore, 'getSourceContent', async () => 'source text');
    swap(notebookStore, 'deleteSource', async (sid) => {
        const found = state.sources.find((x) => x.id === sid) || null;
        state.sources = state.sources.filter((x) => x.id !== sid);
        return found;
    });
    swap(notebookStore, 'listVersions', async () => ({ versions: [], nextCursor: null }));
    swap(notebookStore, 'deleteVersion', async (vid) => { state.deleted.push(vid); return true; });
    swap(notebookCascade, 'cleanupSourceArtifacts', async () => {});
    swap(notebookCascade, 'deleteNotebookCascade', async (id, userId) => ({ deleted: userId === 'alice', sources: 0, kbs: 0 }));
    swap(notebookConversationStore, 'getMessagesWithMeta', async () => ({ messages: [], locked: false }));
    swap(notebookConversationStore, 'deleteForNotebook', async () => true);
});
test.after(restore);
test.beforeEach(reset);

const as = (who) => USERS[who];
const call = (who, method, path, body) => api.call(method, `/api/notebooks/nb1${path}`, { user: as(who), body });

test('a stranger gets 404 on every route: the notebook is not probeable', async () => {
    for (const [method, path, body] of [
        ['GET', ''], ['GET', '/sources'], ['GET', '/versions'], ['GET', '/conversation'],
        ['PUT', '', { name: 'x' }], ['DELETE', ''], ['POST', '/sources/text', { text: 'hi' }],
        ['POST', '/versions', { name: 'x' }], ['DELETE', '/versions/v1'],
    ]) {
        const res = await call('mallory', method, path, body);
        assert.strictEqual(res.status, 404, `${method} ${path}: ${res.text}`);
    }
});

test('a viewer reads everything and changes nothing', async () => {
    const read = await call('vic', 'GET', '');
    assert.strictEqual(read.status, 200, read.text);
    assert.strictEqual(read.body.notebook.role, 'viewer');
    assert.deepStrictEqual(read.body.project, { id: 'p1', name: 'Launch', kind: 'workspace', color: '#0a0', icon: 'x', role: 'viewer' });
    assert.deepStrictEqual(read.body.collab, { eligible: true });
    for (const path of ['/sources', '/sources/s1/content', '/versions', '/conversation']) {
        const res = await call('vic', 'GET', path);
        assert.strictEqual(res.status, 200, `${path}: ${res.text}`);
    }

    const refusals = [
        ['PUT', '', { documentContent: '<p>vic</p>', expectedVersion: 3 }],
        ['PUT', '', { pinned: true }],
        ['DELETE', ''],
        ['POST', '/sources/text', { text: 'hello' }],
        ['POST', '/sources/url', { url: 'https://example.test' }],
        ['PATCH', '/sources/s1', { name: 'Renamed' }],
        ['PATCH', '/sources/reorder', { orderedIds: ['s1'] }],
        ['POST', '/sources/bulk-delete', { ids: ['s1'] }],
        ['DELETE', '/sources/s1'],
        ['POST', '/sources/s1/retry'],
        ['POST', '/sources/s1/cancel'],
        ['POST', '/generate/summary', {}],
        ['POST', '/ai-fill', { documentContent: '{{name}}' }],
        ['POST', '/images'],
        ['POST', '/import-file'],
        ['POST', '/versions', { name: 'Mine' }],
        ['PUT', '/versions/v1/name', { name: 'Mine' }],
        ['POST', '/versions/v1/restore', {}],
        ['DELETE', '/versions/v1'],
    ];
    for (const [method, path, body] of refusals) {
        const res = await call('vic', method, path, body);
        assert.strictEqual(res.status, 403, `${method} ${path}: ${res.text}`);
        assert.match(res.body.code, /^notebook_(read_only|owner_only)$/);
    }
    assert.strictEqual(state.notebook.documentContent, '<p>Hello</p>', 'nothing was written');
    assert.strictEqual(state.sources.length, 1, 'no source was removed');
    assert.deepStrictEqual(state.versions, [], 'not even a version row (the old PUT wrote one before checking)');
    assert.deepStrictEqual(state.deleted, []);
});

test('an editor changes the document and its sources, but not what only the owner decides', async () => {
    const saved = await call('erin', 'PUT', '', { documentContent: '<p>Erin was here</p>', expectedVersion: 3 });
    assert.strictEqual(saved.status, 200, saved.text);
    assert.deepStrictEqual(saved.body, { success: true, version: 4 });
    // The checkpoint holds the state AFTER the save, attributed to her.
    assert.strictEqual(state.versions.length, 1);
    assert.deepStrictEqual(
        { source: state.versions[0].source, html: state.versions[0].html, contributors: state.versions[0].contributors },
        { source: 'checkpoint', html: '<p>Erin was here</p>', contributors: [{ userId: 'erin', kind: 'user' }] },
    );
    assert.deepStrictEqual(state.feed.map((e) => [e.kind, e.projectId, e.notebookId, e.source]), [['content', 'p1', 'nb1', 'checkpoint']]);
    assert.ok(!JSON.stringify(state.feed).includes('Erin was here'), 'ids and counts only in the feed');

    assert.strictEqual((await call('erin', 'PATCH', '/sources/s1', { name: 'Renamed' })).status, 200);
    assert.strictEqual((await call('erin', 'PATCH', '/sources/reorder', { orderedIds: ['s1'] })).status, 200);
    assert.strictEqual((await call('erin', 'DELETE', '/sources/s1')).status, 200);

    const kb = await call('erin', 'PUT', '', { knowledgeBaseIds: [] });
    assert.strictEqual(kb.status, 403, 'which bases the notebook reads is the owner\'s call');
    assert.strictEqual(kb.body.code, 'notebook_owner_only');
    const del = await call('erin', 'DELETE', '');
    assert.strictEqual(del.status, 403);
    assert.strictEqual((await call('erin', 'DELETE', '/versions/v1')).status, 403, 'history is deleted by the owner only');
});

test('the project owner edits a colleague\'s notebook like an editor, and does not delete it', async () => {
    const read = await call('olga', 'GET', '');
    assert.strictEqual(read.body.notebook.role, 'editor');
    assert.strictEqual((await call('olga', 'PUT', '', { name: 'Launch research' })).status, 200);
    assert.deepStrictEqual(state.feed.map((e) => [e.kind, e.notebookId, e.actorId]), [['renamed', 'nb1', 'olga']]);
    assert.strictEqual((await call('olga', 'DELETE', '')).status, 403);
});

test('the owner deletes the notebook and its versions', async () => {
    assert.strictEqual((await call('alice', 'DELETE', '/versions/v9')).status, 200);
    assert.deepStrictEqual(state.deleted, ['v9']);
    const del = await call('alice', 'DELETE', '');
    assert.strictEqual(del.status, 200, del.text);
});

test('a save that lost a race is a 409 for an editor too, and the losing copy is kept as a version', async () => {
    const res = await call('erin', 'PUT', '', { documentContent: '<p>Erin\'s stale copy</p>', expectedVersion: 2 });
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body.code, 'version_conflict');
    assert.strictEqual(res.body.details.currentVersion, 3);
    assert.strictEqual(res.body.details.conflictVersionId, 'v1');
    assert.strictEqual(state.notebook.documentContent, '<p>Hello</p>', 'the newer save stands');
    assert.deepStrictEqual(
        { source: state.versions[0].source, html: state.versions[0].html, createdBy: state.versions[0].createdBy },
        { source: 'conflict', html: '<p>Erin\'s stale copy</p>', createdBy: 'erin' },
        'nobody\'s text is thrown away',
    );
});

test('while the notebook is co-edited, a whole-document save is refused; other fields still save', async () => {
    state.collabActive = true;
    const res = await call('erin', 'PUT', '', { documentContent: '<p>overwrite</p>', expectedVersion: 3 });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'COLLAB_ACTIVE');
    assert.strictEqual(state.notebook.documentContent, '<p>Hello</p>', 'the live document is not overwritten');
    assert.strictEqual(res.body.details.conflictVersionId, 'v1');
    assert.deepStrictEqual(state.versions.map((v) => [v.source, v.html]), [['conflict', '<p>overwrite</p>']], 'the text is kept, not lost');
    const rename = await call('erin', 'PUT', '', { name: 'Renamed while live' });
    assert.strictEqual(rename.status, 200, rename.text);
});

test('a save the store refuses because the notebook went live meanwhile: join the session, the text is kept', async () => {
    state.coEditedAtWrite = true;
    const res = await call('erin', 'PUT', '', { documentContent: '<p>typed solo</p>', expectedVersion: 3 });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'COLLAB_ACTIVE', 'the page joins the live session instead of comparing versions');
    assert.strictEqual(res.body.details.conflictVersionId, 'v1');
    assert.deepStrictEqual(state.versions.map((v) => [v.source, v.html]), [['conflict', '<p>typed solo</p>']]);
    assert.strictEqual(state.notebook.documentContent, '<p>Hello</p>');
});

test('a notebook outside any project has no project, no co-editing and no feed', async () => {
    state.notebook.projectId = null;
    const read = await call('alice', 'GET', '');
    assert.strictEqual(read.body.project, null);
    assert.deepStrictEqual(read.body.collab, { eligible: false });
    assert.strictEqual((await call('erin', 'GET', '')).status, 404, 'a standalone notebook is its owner\'s alone');
});

test('the pin is the owner\'s own: an editor or the project owner can neither set nor clear it', async () => {
    // It orders and filters alice's personal library; a colleague pinning or
    // unpinning her notebook rearranged her list.
    for (const who of ['erin', 'olga']) {
        for (const pinned of [true, false]) {
            const res = await call(who, 'PUT', '', { pinned });
            assert.strictEqual(res.status, 403, `${who} pinned=${pinned}: ${res.text}`);
            assert.strictEqual(res.body.code, 'notebook_owner_only');
        }
        // Not even alongside a change the editor may make.
        assert.strictEqual((await call(who, 'PUT', '', { name: 'Renamed', pinned: true })).status, 403);
    }
    assert.strictEqual(state.notebook.pinned, undefined, 'nothing was written');
    assert.strictEqual(state.notebook.name, 'Research');

    const own = await call('alice', 'PUT', '', { pinned: true });
    assert.strictEqual(own.status, 200, own.text);
    assert.strictEqual(state.notebook.pinned, true);
});
