'use strict';

/**
 * GET/accept/reject routes for document suggestions, served with fakes.
 *
 * Run: cd server && node --test routes/documentSuggestions.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
const { makeDocumentSuggestionsRouter } = require('./documentSuggestions');

const docs = {
    own: { id: 'own', userId: 'anna' },
    proj: { id: 'proj', userId: 'anna', projectRole: null },
    managed: { id: 'managed', userId: 'anna' },
};
const grants = { // who sees what, beyond the owner
    'bob:proj': { projectRole: 'viewer' },
    'cleo:proj': { projectRole: 'editor' },
    'dan:proj': { sharingRole: 'editor' },
    'eve:proj': { sharingRole: 'viewer' },
};

const rows = [];
const resolved = [];
const store = {
    async list(_t, id, { status }) { return rows.filter((r) => r.targetId === id && status.includes(r.status)); },
    async get(id) { return rows.find((r) => r.id === id) || null; },
    async listBatch(_t, id, batchId) { return rows.filter((r) => r.targetId === id && r.batchId === batchId); },
};
const applier = {
    async accept({ doc, ids, actor }) {
        resolved.push(['accept', doc.id, ids, actor.userId]);
        if (applier.mode === 'stale') return { accepted: [], rejected: [], stale: ids, versionId: null };
        if (applier.mode === 'none') return { accepted: [], rejected: [], stale: [], versionId: null };
        return { accepted: ids.slice(0, 1), rejected: [], stale: ids.slice(1), versionId: 'v2' };
    },
    async reject({ doc, ids, actor }) { resolved.push(['reject', doc.id, ids, actor.userId]); return { accepted: [], rejected: ids, stale: [], versionId: null }; },
};

const router = makeDocumentSuggestionsRouter({
    documents: {
        async getDocument(id, userId) {
            const d = docs[id];
            if (!d) return null;
            if (d.userId === userId) return { ...d };
            const g = grants[`${userId}:${id}`];
            return g ? { ...d, ...g } : null;
        },
    },
    store, applier, requireAuth: (_req, _res, next) => next(),
    isManaged: async (id) => id === 'managed',
    isOrgAdmin: async () => false,
});

const app = express();
app.use((req, _res, next) => { req.session = { user: { id: req.headers['x-user'] || 'anna' } }; next(); });
app.use('/api/studio-documents', router);
app.use(terminalErrorHandler);
const server = http.createServer(app);
const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => server.close());

async function call(method, path, user = 'anna') {
    await ready;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/studio-documents${path}`, { method, headers: { 'x-user': user } });
    return { status: res.status, body: await res.json() };
}

const row = (id, extra = {}) => ({ id, batchId: 'b1', targetId: 'proj', kind: 'text', status: 'open', anchor: { quote: 'q' }, before: [], after: [], summary: id, authorKind: 'ai', agentId: null, createdAt: '2026-10-09', authorUserId: 'anna', ...extra });
test.beforeEach(() => {
    rows.length = 0; resolved.length = 0; applier.mode = null;
    rows.push(row('s1'), row('s2'), row('s3', { status: 'stale' }), row('s4', { status: 'accepted' }), row('x1', { targetId: 'own', batchId: 'b9' }));
});

test('GET lists open and stale suggestions in the contract shape, with the open count; a reader may', async () => {
    const out = await call('GET', '/proj/suggestions', 'bob');
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(out.body.suggestions.map((s) => s.id), ['s1', 's2', 's3']);
    assert.strictEqual(out.body.open, 2);
    assert.deepStrictEqual(Object.keys(out.body.suggestions[0]).sort(), ['agentId', 'anchor', 'after', 'authorKind', 'batchId', 'before', 'createdAt', 'id', 'kind', 'status', 'summary'].sort());
    assert.ok(!('authorUserId' in out.body.suggestions[0]));
});

test('a stranger gets 404 for a document they cannot read, with no hint', async () => {
    assert.strictEqual((await call('GET', '/proj/suggestions', 'zed')).status, 404);
    assert.strictEqual((await call('POST', '/proj/suggestions/s1/accept', 'zed')).status, 404);
    assert.strictEqual((await call('GET', '/nope/suggestions')).status, 404);
});

test('accept / reject need edit access: viewers get 403, owner, project editor and sharing editor pass', async () => {
    for (const user of ['bob', 'eve']) {
        const r = await call('POST', '/proj/suggestions/s1/accept', user);
        assert.strictEqual(r.status, 403, user);
        assert.strictEqual(r.body.code, 'document_read_only');
        assert.strictEqual((await call('POST', '/proj/suggestions/s1/reject', user)).status, 403, user);
    }
    assert.strictEqual(resolved.length, 0);
    for (const user of ['anna', 'cleo', 'dan']) assert.strictEqual((await call('POST', '/proj/suggestions/s1/accept', user)).status, 200, user);
    assert.deepStrictEqual(resolved.map((r) => r[3]), ['anna', 'cleo', 'dan']);
});

test('a Solution-managed document is not editable, as on GET /:id', async () => {
    rows.push(row('m1', { targetId: 'managed' }));
    assert.strictEqual((await call('POST', '/managed/suggestions/m1/accept')).status, 403);
});

test('accept one: answers accepted / rejected / stale / versionId', async () => {
    const out = await call('POST', '/proj/suggestions/s1/accept');
    assert.deepStrictEqual(out.body, { accepted: ['s1'], rejected: [], stale: [], versionId: 'v2' });
    assert.deepStrictEqual(resolved[0].slice(0, 3), ['accept', 'proj', ['s1']]);
});

test('accept answers 409 suggestion_stale when nothing could apply, 404 when nothing was open', async () => {
    applier.mode = 'stale';
    const stale = await call('POST', '/proj/suggestions/s1/accept');
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'suggestion_stale');
    applier.mode = 'none';
    assert.strictEqual((await call('POST', '/proj/suggestions/s4/accept')).status, 404);
});

test('a suggestion id of another document is not found', async () => {
    const out = await call('POST', '/proj/suggestions/x1/accept');
    assert.strictEqual(out.status, 404);
    assert.strictEqual(out.body.code, 'suggestion_not_found');
    assert.strictEqual(resolved.length, 0);
    assert.strictEqual((await call('POST', '/proj/suggestions/ghost/reject')).status, 404);
});

test('batch accept takes every open suggestion of the batch in one call; accepted ones are left out', async () => {
    const out = await call('POST', '/proj/suggestions/batch/b1/accept');
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(resolved[0].slice(0, 3), ['accept', 'proj', ['s1', 's2', 's3']]);
    assert.deepStrictEqual(out.body.accepted, ['s1']);
    assert.strictEqual((await call('POST', '/proj/suggestions/batch/none/accept')).status, 404);
});

test('batch reject, and reject of one', async () => {
    const batch = await call('POST', '/proj/suggestions/batch/b1/reject');
    assert.deepStrictEqual(batch.body.rejected, ['s1', 's2', 's3']);
    const one = await call('POST', '/proj/suggestions/s2/reject');
    assert.deepStrictEqual(one.body, { accepted: [], rejected: ['s2'], stale: [], versionId: null });
});
