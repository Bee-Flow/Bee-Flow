/**
 * Asking colleagues in a project for a template's fields
 * (routes/studioDocuments/valueRequests.mts) and the values route closing the
 * request (templateValues.mts). DB-free: the stores are fakes handed to the
 * router factories, the request goes through express for real.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { makeValueRequestsRouter } = require('./valueRequests.mts');
const { makeTemplateValuesRouter } = require('./templateValues.mts');

const CONTRACT = { parameters: [
    { key: 'iban', type: 'text', label: 'IBAN', required: true },
    { key: 'kvk', type: 'text', label: 'Chamber of commerce number', required: true },
    { key: 'name', type: 'text', label: 'Name' },
] };

function fakeStore() {
    const docs = new Map();
    docs.set('doc-1', { id: 'doc-1', userId: 'alice', name: 'Offer', kind: 'document', docType: 'quote', projectId: 'p1', versionId: 'v1',
        bodyHtml: '<p>{{iban}} {{kvk}} {{name}}</p>', settings: { contract: CONTRACT, sampleValues: {} } });
    docs.set('doc-loose', { id: 'doc-loose', userId: 'alice', name: 'Loose', kind: 'document', projectId: null, versionId: 'v1', settings: { contract: CONTRACT } });
    return {
        docs,
        async getDocument(id, userId) {
            const d = docs.get(id);
            if (!d) return null;
            if (d.projectId === 'p1' && ['alice', 'bob', 'carol'].includes(userId)) return { ...d, projectRole: userId === 'carol' ? 'viewer' : 'editor' };
            return d.userId === userId ? d : null;
        },
        async updateDocument(id, _ctx, updates) {
            const d = docs.get(id);
            const next = { ...d, ...updates, versionId: `${d.versionId}+` };
            docs.set(id, next);
            return next;
        },
    };
}

async function withServer(store, fn) {
    const notified = [];
    const app = express();
    app.use(express.json());
    const requireAuth = (req, res, next) => {
        const user = req.headers['x-user'];
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        req.session = { user: { id: String(user), name: user === 'alice' ? 'Alice' : user } };
        return next();
    };
    const notify = async (n) => { notified.push(n); };
    const name = async (_user, key, vars) => `${key} ${JSON.stringify(vars)}`;
    const projectRole = async (userId) => ({ alice: 'owner', bob: 'editor', carol: 'viewer' })[userId] || null;
    app.use('/api/studio-documents', makeValueRequestsRouter({ store: () => store, requireAuth, notify, name, projectRole }));
    app.use('/api/studio-documents', makeTemplateValuesRouter({ store: () => store, requireAuth, notify }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/studio-documents`;
    const call = async (method, path, body, user = 'alice') => {
        const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };
    try { await fn(call, notified); } finally { server.close(); }
}

test('asking a colleague stores the request and rings their bell, with the fields by label and a link into the project', async () => {
    const store = fakeStore();
    await withServer(store, async (call, notified) => {
        const res = await call('POST', '/doc-1/value-requests', { fields: ['iban', 'kvk'], assigneeIds: ['bob'], message: 'From the contract, please' });
        assert.equal(res.status, 201);
        assert.equal(res.body.requests.length, 1);
        assert.deepEqual(res.body.requests[0].fields, ['iban', 'kvk']);
        assert.equal(notified.length, 1);
        assert.equal(notified[0].userId, 'bob');
        assert.equal(notified[0].link, '/app/projects/p1/documents/doc-1');
        assert.match(notified[0].message, /IBAN, Chamber of commerce number/);
        assert.match(notified[0].message, /From the contract, please/);
    });
});

test('when the asked fields are filled in, the request closes and the one who asked is told', async () => {
    const store = fakeStore();
    await withServer(store, async (call, notified) => {
        await call('POST', '/doc-1/value-requests', { fields: ['iban', 'kvk'], assigneeIds: ['bob'] });
        const first = await call('PUT', '/doc-1/values', { values: { iban: 'NL91ABNA0417164300' } }, 'bob');
        assert.equal(first.status, 200);
        assert.equal(first.body.filledBy.iban.userId, 'bob');
        assert.equal(first.body.requests[0].doneAt, undefined);
        const second = await call('PUT', '/doc-1/values', { values: { kvk: '12345678' } }, 'bob');
        assert.ok(second.body.requests[0].doneAt);
        const toAlice = notified.filter((n) => n.userId === 'alice');
        assert.equal(toAlice.length, 1);
        assert.match(toAlice[0].title, /Offer/);
        assert.equal(toAlice[0].link, '/app/projects/p1/documents/doc-1');
    });
});

test('only an editor of a project document asks, and only project editors can be asked', async () => {
    const store = fakeStore();
    await withServer(store, async (call) => {
        assert.equal((await call('POST', '/doc-1/value-requests', { fields: ['iban'], assigneeIds: ['carol'] })).status, 400, 'a viewer cannot fill in');
        assert.equal((await call('POST', '/doc-1/value-requests', { fields: ['iban'], assigneeIds: ['alice'] })).status, 400, 'not yourself');
        assert.equal((await call('POST', '/doc-1/value-requests', { fields: ['iban'], assigneeIds: ['bob'] }, 'carol')).status, 403);
        assert.equal((await call('POST', '/doc-loose/value-requests', { fields: ['iban'], assigneeIds: ['bob'] })).status, 400);
        assert.equal((await call('POST', '/doc-1/value-requests', { fields: ['iban'], assigneeIds: ['bob'] }, 'mallory')).status, 404);
    });
});

test('who asked, or who was asked, can close a request; nobody else', async () => {
    const store = fakeStore();
    await withServer(store, async (call) => {
        const made = await call('POST', '/doc-1/value-requests', { fields: ['iban'], assigneeIds: ['bob'] });
        const id = made.body.requests[0].id;
        assert.equal((await call('POST', `/doc-1/value-requests/${id}/close`, null, 'carol')).status, 403);
        const closed = await call('POST', `/doc-1/value-requests/${id}/close`, null, 'bob');
        assert.equal(closed.status, 200);
        assert.ok(closed.body.requests[0].cancelledAt);
        assert.equal((await call('POST', `/doc-1/value-requests/${id}/close`, null, 'alice')).status, 404);
    });
});
