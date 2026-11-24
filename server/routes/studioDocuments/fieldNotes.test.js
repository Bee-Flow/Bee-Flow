/**
 * Notes for the others on a document that is filled in together
 * (routes/studioDocuments/fieldNotes.mts). DB-free: the store is a fake handed
 * to the router factory, the request goes through express for real.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { makeFieldNotesRouter } = require('./fieldNotes.mts');

const CONTRACT = { parameters: [{ key: 'price', type: 'number', label: 'Price', required: true }, { key: 'scope', type: 'text', label: 'Scope' }] };
const ROLES = { alice: 'editor', bob: 'editor', carol: 'viewer' };

function fakeStore() {
    const docs = new Map([
        ['doc-1', { id: 'doc-1', userId: 'alice', name: 'Offer', kind: 'document', projectId: 'p1', versionId: 'v1', bodyHtml: '<p>{{price}} {{scope}}</p>', settings: { contract: CONTRACT } }],
        ['tpl-1', { id: 'tpl-1', userId: 'alice', name: 'Template', kind: 'template', versionId: 'v1', settings: { contract: CONTRACT } }],
    ]);
    return {
        docs,
        async getDocument(id, userId) {
            const d = docs.get(id);
            if (!d) return null;
            if (d.projectId && ROLES[userId]) return { ...d, projectRole: ROLES[userId] };
            return d.userId === userId ? d : null;
        },
        async updateDocument(id, _userId, updates) {
            const next = { ...docs.get(id), settings: updates.settings, versionId: `${docs.get(id).versionId}+` };
            docs.set(id, next);
            return next;
        },
    };
}

async function withNotes(store, fn) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: String(req.headers['x-user']) } }; next(); });
    app.use('/api/studio-documents', makeFieldNotesRouter({ store: () => store, requireAuth: (_req, _res, next) => next() }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
    const server = app.listen(0);
    const root = `http://127.0.0.1:${server.address().port}/api/studio-documents/`;
    const note = async (method, path, body, user = 'alice') => {
        const res = await fetch(root + path, { method, headers: { 'content-type': 'application/json', 'x-user': user }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, body: await res.json() };
    };
    try { await fn(note); } finally { server.close(); }
}

const shape = (notes) => notes.map((n) => [n.key, n.userId, n.text]);

test('a note is left at a field or on the whole document, and everyone who fills it in reads it', async () => {
    const store = fakeStore();
    await withNotes(store, async (note) => {
        const first = await note('POST', 'doc-1/field-notes', { key: 'price', text: '  Still being negotiated, leave it.  ' });
        assert.equal(first.status, 201);
        assert.deepEqual(shape(first.body.notes), [['price', 'alice', 'Still being negotiated, leave it.']]);
        const whole = await note('POST', 'doc-1/field-notes', { text: 'The client wants this before Friday.' }, 'bob');
        assert.deepEqual(shape(whole.body.notes).map((n) => n[0]), ['price', '']);
        assert.equal(store.docs.get('doc-1').settings.fieldNotes.length, 2);
        assert.equal(whole.body.documentId, 'doc-1', 'answered as the form\'s other routes: where the filling stands');
        assert.equal(whole.body.complete, false);
    });
});

test('a note is checked: some text, a field of this document, an editor, never a template', async () => {
    await withNotes(fakeStore(), async (note) => {
        assert.equal((await note('POST', 'doc-1/field-notes', { key: 'price', text: '   ' })).status, 400);
        assert.equal((await note('POST', 'doc-1/field-notes', { key: 'price', text: 'x'.repeat(501) })).status, 400);
        const unknown = await note('POST', 'doc-1/field-notes', { key: 'nope', text: 'x' });
        assert.equal(unknown.status, 422);
        assert.equal(unknown.body.code, 'field_note_unknown_field');
        assert.equal((await note('POST', 'doc-1/field-notes', { text: 'x' }, 'carol')).status, 403, 'a viewer reads, and leaves no note');
        assert.equal((await note('POST', 'doc-1/field-notes', { text: 'x' }, 'mallory')).status, 404);
        assert.equal((await note('POST', 'tpl-1/field-notes', { text: 'x' })).status, 400);
    });
});

test('only who wrote a note removes it', async () => {
    await withNotes(fakeStore(), async (note) => {
        const made = await note('POST', 'doc-1/field-notes', { key: 'scope', text: 'Ask legal first.' });
        const id = made.body.notes[0].id;
        const other = await note('DELETE', `doc-1/field-notes/${id}`, null, 'bob');
        assert.equal(other.status, 403);
        assert.equal(other.body.code, 'field_note_not_yours');
        const gone = await note('DELETE', `doc-1/field-notes/${id}`);
        assert.equal(gone.status, 200);
        assert.deepEqual(gone.body.notes, []);
        assert.equal((await note('DELETE', `doc-1/field-notes/${id}`)).status, 404);
    });
});
