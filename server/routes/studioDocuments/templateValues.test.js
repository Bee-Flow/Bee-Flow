/**
 * PUT /api/studio-documents/:id/values (routes/studioDocuments/templateValues.mts),
 * the form under a chat answer that fills in a template. DB-free: the store is a
 * fake handed to the router factory, the contract code is the real one, and the
 * request goes through express (body validation, error answers) for real.
 * Organisation isolation against the real store: tenantIsolation.matrix.test.js.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { makeTemplateValuesRouter } = require('./templateValues.mts');

const CONTRACT = {
    parameters: [
        { key: 'client_name', type: 'text', label: 'Client name', required: true },
        { key: 'amount', type: 'number', label: 'Amount', required: true },
        { key: 'date', type: 'date', label: 'Offer date' },
        { key: 'lines', type: 'list', label: 'Lines', fields: [{ key: 'what', type: 'text' }, { key: 'price', type: 'number' }] },
    ],
};
const BODY = '<p>{{client_name}} {{amount}} {{date}}</p>';

function fakeStore() {
    const docs = new Map();
    const writes = [];
    const add = (doc) => docs.set(doc.id, { versionId: 'v1', kind: 'document', docType: 'quote', bodyHtml: BODY, settings: { contract: CONTRACT }, ...doc });
    add({ id: 'doc-1', userId: 'alice', name: 'Offer', settings: { contract: CONTRACT, sampleValues: { client_name: 'Van Dijk' }, templateFill: { conversationId: 'c1', templateId: 't1', startedAt: '2026-11-20T10:00:00.000Z' } } });
    add({ id: 'doc-viewer', userId: 'bob', name: 'Shared to read', sharingRole: 'viewer' });
    add({ id: 'tpl-1', userId: 'alice', name: 'A template', kind: 'template' });
    let conflictOnce = false;
    return {
        docs, writes,
        failNextWithConflict() { conflictOnce = true; },
        async getDocument(id, userId) {
            const d = docs.get(id);
            if (!d) return null;
            if (d.userId !== userId && !d.sharingRole) return null;
            return structuredClone(d);
        },
        async updateDocument(id, userId, updates) {
            if (conflictOnce) {
                conflictOnce = false;
                // Someone else saved meanwhile: the stored values moved on.
                const d = docs.get(id);
                d.settings = { ...d.settings, sampleValues: { ...d.settings.sampleValues, date: '2026-01-02' } };
                d.versionId = 'v-other';
                throw Object.assign(new Error('This document changed while you were editing.'), { status: 409, errorClass: 'document_conflict' });
            }
            writes.push({ id, userId, updates });
            const d = docs.get(id);
            if (!d || d.userId !== userId) return null;
            Object.assign(d, { settings: updates.settings, versionId: `${d.versionId}+` });
            return structuredClone(d);
        },
    };
}

async function withServer(store, fn) {
    const app = express();
    app.use(express.json());
    const requireAuth = (req, res, next) => {
        const user = req.headers['x-user'];
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        req.session = { user: { id: String(user) } };
        return next();
    };
    app.use('/api/studio-documents', makeTemplateValuesRouter({ store: () => store, requireAuth }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/studio-documents`;
    const put = async (id, body, user = 'alice') => {
        const res = await fetch(`${base}/${id}/values`, {
            method: 'PUT', headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };
    try { await fn(put); } finally { server.close(); }
}

test('saves what fits, answers what is missing, and names each value that does not fit', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        const res = await put('doc-1', { values: { amount: '12,5', date: '2026-02-30', colour: 'red', lines: [{ what: 'Hours', price: '40' }] } });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.values, { client_name: 'Van Dijk', amount: 12.5, lines: [{ what: 'Hours', price: 40 }] });
        assert.deepEqual(res.body.rejected.map((r) => r.key).sort(), ['colour', 'date']);
        assert.match(res.body.rejected.find((r) => r.key === 'date').message, /YYYY-MM-DD/);
        assert.deepEqual(res.body.missingRequired, []);
        assert.equal(res.body.complete, true);
        assert.equal(res.body.documentId, 'doc-1');
        assert.equal(res.body.finished, false);
        assert.equal(store.writes[0].updates.source, 'autosave', 'the person\'s edit, not an AI revision');
        assert.equal(store.docs.get('doc-1').settings.templateFill.conversationId, 'c1', 'the conversation link is kept');
    });
});

test('null clears a field, and then it is missing again', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        const res = await put('doc-1', { values: { client_name: null } });
        assert.deepEqual(res.body.values, {});
        assert.deepEqual(res.body.missingRequired.map((m) => m.label), ['Client name', 'Amount']);
        assert.equal(res.body.complete, false);
    });
});

test('finish marks the fill finished only when nothing required is missing', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        const early = await put('doc-1', { values: {}, finish: true });
        assert.equal(early.body.finished, false);
        assert.deepEqual(early.body.missingRequired.map((m) => m.label), ['Amount']);
        assert.equal(store.docs.get('doc-1').settings.templateFill.finishedAt, undefined);
        const done = await put('doc-1', { values: { amount: 10 }, finish: true });
        assert.equal(done.body.finished, true);
        assert.ok(store.docs.get('doc-1').settings.templateFill.finishedAt);
    });
});

test('a save that lost a race is merged once more on the fresh document', async () => {
    const store = fakeStore();
    store.failNextWithConflict();
    await withServer(store, async (put) => {
        const res = await put('doc-1', { values: { amount: 7 } });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.values, { client_name: 'Van Dijk', date: '2026-01-02', amount: 7 }, 'the other save is kept');
    });
});

test('the body is checked: values is an object, and nothing else is taken', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        for (const body of [{ values: 'x' }, { values: [1] }, {}, { values: {}, extra: 1 }, { values: {}, finish: 'yes' }]) {
            const res = await put('doc-1', body);
            assert.equal(res.status, 400, JSON.stringify(body));
        }
        const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 'x']));
        assert.equal((await put('doc-1', { values: many })).status, 400);
        assert.equal(store.writes.length, 0, 'a refused body changes nothing');
    });
});

test('access: signed in, a document the caller may see, an editor, and never a template', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        assert.equal((await put('doc-1', { values: { amount: 1 } }, null)).status, 401);
        assert.equal((await put('doc-1', { values: { amount: 1 } }, 'eve')).status, 404, 'a stranger gets the same 404 as a missing id');
        assert.equal((await put('nope', { values: {} })).status, 404);
        const viewer = await put('doc-viewer', { values: { amount: 1 } }, 'alice');
        assert.equal(viewer.status, 403);
        assert.equal(viewer.body.code, 'document_read_only');
        const template = await put('tpl-1', { values: { amount: 1 } });
        assert.equal(template.status, 400);
        assert.equal(template.body.code, 'document_not_fillable');
        assert.equal(store.writes.length, 0);
    });
});
