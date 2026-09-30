'use strict';

/**
 * The uniform versions API of a Studio document (studioDocuments/versions.js),
 * served with fakes through its factory: who may read, name, restore and
 * delete; the shapes; a page edited live restored through the live layer.
 *
 * The store's own rules are proven against Postgres in
 * stores/documentStore.test.js; this is what the ROUTES make of them.
 *
 * Run: cd server && node --test routes/studioDocuments/versions.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../core/http/routeHarness');
const { makeDocumentVersionsRouter } = require('./versions');

const DOC = { id: 'd1', userId: 'owner', name: 'Plan', docType: 'report', versionId: 'v2', baselineVersionId: 'v1', projectId: 'p1', bodyHtml: '<p>now</p>' };
const PAGE = { ...DOC, id: 'pg1', docType: 'page' };
const ROLES = { owner: undefined, editor: 'editor', viewer: 'viewer' };
const META = (id, extra = {}) => ({ id, seq: 2, source: 'autosave', name: null, summary: '', createdAt: '2026-09-01T10:00:00.000Z', createdBy: 'editor', contributors: [{ userId: 'editor', kind: 'user' }], stats: null, pinned: false, restoredFrom: null, ...extra });

const calls = [];
let live = null;
const feedCalls = [];
const docs = {
    async getDocument(id, userId) {
        const base = id === DOC.id ? DOC : id === PAGE.id ? PAGE : null;
        if (!base || !(userId in ROLES)) return null;
        return { ...base, ...(ROLES[userId] ? { projectRole: ROLES[userId] } : {}) };
    },
    async listVersions(id, userId, options) {
        calls.push(['list', id, userId, options]);
        if (!(await docs.getDocument(id, userId))) return null;
        return { versions: [META('v2'), META('v1', { source: 'created', createdBy: 'owner', contributors: [] })], nextCursor: 'next' };
    },
    async getVersion(id, userId, ref) {
        const doc = await docs.getDocument(id, userId);
        if (!doc || !(['current', 'v1', 'v2', 'v9'].includes(ref) || ref.startsWith('rec-'))) return null;
        return { document: doc, version: { ...META(ref === 'current' ? doc.versionId : ref), content: { html: '<p>old</p><script>x()</script>', markdown: null } } };
    },
    async createNamedVersion(id, ctx, name) { calls.push(['name-current', id, ctx.userId, name]); return META('v2', { name }); },
    async nameVersion(id, ctx, ref, name) { calls.push(['name', id, ctx.userId, ref, name]); return ref === 'v2' ? META('v2', { name }) : undefined; },
    async restoreVersion(id, ctx, ref, opts) {
        calls.push(['restore', id, ctx.userId, ref, opts]);
        if (ref === 'v1' && opts.expectedVersionId && opts.expectedVersionId !== 'v2') {
            throw Object.assign(new Error('This document changed.'), { status: 409, errorClass: 'document_conflict' });
        }
        return ref === 'v1' ? { current: { ...DOC, versionId: 'v3' }, version: META('v3', { source: 'restore', restoredFrom: 'v1' }) } : null;
    },
    async deleteVersion(id, userId, ref, options = {}) {
        calls.push(['delete', id, userId, ref]);
        if (!(await docs.getDocument(id, userId))) return null;
        if (userId !== 'owner') throw Object.assign(new Error('Only the owner of this document can delete versions of it.'), { status: 403, errorClass: 'document_owner_only' });
        // As the store does: the pins the route hands in are looked up and refused.
        const pins = typeof options.referencedIds === 'function' ? await options.referencedIds() : (options.referencedIds || []);
        if (new Set(pins).has(ref)) throw Object.assign(new Error('A routine or an app uses this version of the document, so it stays.'), { status: 409, errorClass: 'version_in_use' });
        return ref === 'v1' || ref === 'v9';
    },
    async recordVersion(id, input) { calls.push(['record', id, input.source, input.restoredFrom || null, input.html]); return { versionId: `rec-${input.source}`, seq: 9 }; },
};

const router = makeDocumentVersionsRouter({
    documents: docs,
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })),
    hasPermission: async () => false,
    liveCollabFor: async (doc) => (doc.docType === 'page' ? live : null),
    feed: { recordContentChange: async (doc, change) => { feedCalls.push([doc.id, change.source, change.versionId]); } },
    describePeople: async (ids) => Object.fromEntries([...new Set(ids)].filter(Boolean).map((id) => [id, { name: id.toUpperCase() }])),
    sanitize: (html) => html.replace(/<script[\s\S]*?<\/script>/g, ''),
    pinnedVersionIds: async () => new Set(['v9']),
});
const api = h.serve('/api/studio-documents/:id/versions', router);
test.after(api.close);
test.beforeEach(() => { calls.length = 0; feedCalls.length = 0; live = null; });

const as = (id) => ({ id, organizationId: 'org1' });
const base = '/api/studio-documents/d1/versions';

test('any reader lists the history with names for the people in it; a stranger gets 404', async () => {
    const res = await api.call('GET', `${base}?limit=10`, { user: as('viewer') });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.versions.map(v => v.id), ['v2', 'v1']);
    assert.strictEqual(res.body.nextCursor, 'next');
    assert.deepStrictEqual(res.body.people, { editor: { name: 'EDITOR' }, owner: { name: 'OWNER' } });
    assert.deepStrictEqual(calls[0][3], { cursor: null, limit: 10 });
    assert.strictEqual((await api.call('GET', base, { user: as('stranger') })).status, 404);
    assert.strictEqual((await api.call('GET', base, { user: null })).status, 401);
});

test('one version reads with its content sanitised; an unknown one is 404', async () => {
    const res = await api.call('GET', `${base}/v1`, { user: as('viewer') });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.version.content, { html: '<p>old</p>', markdown: null });
    assert.strictEqual((await api.call('GET', `${base}/nope`, { user: as('viewer') })).status, 404);
    assert.strictEqual((await api.call('GET', `${base}/bad%20ref`, { user: as('viewer') })).status, 404);
});

test('the current state of a live page is read from the live layer', async () => {
    live = { readHtml: async () => '<p>typed live</p>' };
    const res = await api.call('GET', '/api/studio-documents/pg1/versions/current', { user: as('viewer') });
    assert.strictEqual(res.body.version.content.html, '<p>typed live</p>');
});

test('naming: an editor names the current state and the project feed hears it; a viewer is refused', async () => {
    const res = await api.call('POST', base, { user: as('editor'), body: { name: 'Sent to client' } });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body.version.name, 'Sent to client');
    assert.deepStrictEqual(calls, [['name-current', 'd1', 'editor', 'Sent to client']]);
    assert.deepStrictEqual(feedCalls, [['d1', 'named', 'v2']]);
    const viewer = await api.call('POST', base, { user: as('viewer'), body: { name: 'Nope' } });
    assert.strictEqual(viewer.status, 403);
    assert.strictEqual(viewer.body.code, 'document_read_only');
    assert.strictEqual((await api.call('POST', base, { user: as('stranger'), body: { name: 'x' } })).status, 404);
});

test('naming a live page names what people see, through a checkpoint of the live state', async () => {
    live = { readHtml: async () => '<p>live words</p>' };
    const res = await api.call('POST', '/api/studio-documents/pg1/versions', { user: as('editor'), body: { name: 'Agreed' } });
    assert.strictEqual(res.status, 201, res.text);
    assert.deepStrictEqual(calls[0], ['record', 'pg1', 'named', null, '<p>live words</p>']);
});

test('renaming a version and clearing its name; unknown versions 404; viewers 403', async () => {
    const res = await api.call('PUT', `${base}/v2/name`, { user: as('editor'), body: { name: 'Final' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.version.name, 'Final');
    const cleared = await api.call('PUT', `${base}/v2/name`, { user: as('editor'), body: { name: null } });
    assert.strictEqual(cleared.body.version.name, null);
    assert.strictEqual((await api.call('PUT', `${base}/v7/name`, { user: as('editor'), body: { name: 'x' } })).status, 404);
    assert.strictEqual((await api.call('PUT', `${base}/v2/name`, { user: as('viewer'), body: { name: 'x' } })).status, 403);
});

test('a restore is an edit: a viewer is refused, a stale expectation is a 409, a good one restores and tells the feed', async () => {
    const viewer = await api.call('POST', `${base}/v1/restore`, { user: as('viewer'), body: {} });
    assert.strictEqual(viewer.status, 403);
    const stale = await api.call('POST', `${base}/v1/restore`, { user: as('editor'), body: { expectedVersion: 'v1' } });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'document_conflict');
    const ok = await api.call('POST', `${base}/v1/restore`, { user: as('editor'), body: { expectedVersionId: 'v2' } });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.version.restoredFrom, 'v1');
    assert.strictEqual(ok.body.current.versionId, 'v3');
    assert.strictEqual(ok.body.document.versionId, 'v3', 'the older editor reads `document`');
    assert.deepStrictEqual(feedCalls, [['d1', 'restore', 'v3']]);
    assert.strictEqual((await api.call('POST', `${base}/current/restore`, { user: as('editor'), body: {} })).status, 404);
});

/**
 * The live layer as core/collab's lifecycle behaves on a restore: it records
 * pre_restore and the 'restore' version itself (with the actor's
 * `restoredFrom`) and tells the change feed, unless `recordVersions: false`.
 */
function recordingLive(written) {
    return {
        readHtml: async () => '<p>live now</p>',
        applyServerEdit: async (kind, id, actor, change) => {
            if (actor.recordVersions !== false) {
                written.push(['pre_restore', null, '<p>live now</p>'], ['restore', actor.restoredFrom ?? null, change.replaceWith.html]);
                feedCalls.push([id, 'restore', 'v9']);
            }
            return { applied: true, seq: 4, changed: true, versionId: 'v9' };
        },
    };
}

test('restoring a live page: the live layer replaces the live document and records the restore once, with where it came from', async () => {
    const written = [];
    live = recordingLive(written);
    const res = await api.call('POST', '/api/studio-documents/pg1/versions/v1/restore', { user: as('editor'), body: {} });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written, [
        ['pre_restore', null, '<p>live now</p>'],
        ['restore', 'v1', '<p>old</p><script>x()</script>'],
    ], 'one restore version, and it names the version it restored');
    assert.deepStrictEqual(calls.filter(c => c[0] === 'record'), [], 'the route writes no second pre_restore or restore row');
    assert.deepStrictEqual(feedCalls, [['pg1', 'restore', 'v9']], 'and the change feed counts the restore once');
    assert.strictEqual(res.body.version.id, 'v9', 'the answer is the version the live layer wrote');
    assert.ok(!calls.some(c => c[0] === 'restore'), 'the stored-body restore is not used');
});

test('a live page whose live layer turns out to hold nothing falls back to the stored restore', async () => {
    live = { readHtml: async () => '<p>x</p>', applyServerEdit: async () => ({ applied: false }) };
    const res = await api.call('POST', '/api/studio-documents/pg1/versions/v1/restore', { user: as('editor'), body: {} });
    assert.strictEqual(res.status, 200);
    assert.ok(calls.some(c => c[0] === 'restore'));
});

test('when it cannot be told whether a page is live, nothing is written', async () => {
    const failing = makeDocumentVersionsRouter({
        documents: docs, requireAuth: (req, res, next) => next(), hasPermission: async () => false,
        liveCollabFor: async () => { throw new Error('db down'); }, feed: { recordContentChange: async () => {} },
        describePeople: async () => ({}), sanitize: (x) => x,
    });
    const app = h.serve('/api/studio-documents/:id/versions', failing);
    try {
        const res = await app.call('POST', '/api/studio-documents/pg1/versions/v1/restore', { user: as('editor'), body: {} });
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.code, 'collab_unavailable');
        assert.deepStrictEqual(calls, []);
    } finally { await app.close(); }
});

test('only the owner deletes a version; others are told or not shown', async () => {
    assert.strictEqual((await api.call('DELETE', `${base}/v1`, { user: as('owner') })).status, 200);
    const editor = await api.call('DELETE', `${base}/v1`, { user: as('editor') });
    assert.strictEqual(editor.status, 403);
    assert.strictEqual(editor.body.code, 'document_owner_only');
    assert.strictEqual((await api.call('DELETE', `${base}/v1`, { user: as('stranger') })).status, 404);
    assert.strictEqual((await api.call('DELETE', `${base}/v8`, { user: as('owner') })).status, 404);
});

test('a version a routine or an app pins is not deleted: 409 version_in_use', async () => {
    const res = await api.call('DELETE', `${base}/v9`, { user: as('owner') });
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body.code, 'version_in_use');
    assert.match(res.body.error, /routine or an app/);
});
