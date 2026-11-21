/**
 * GET /api/studio-documents/:id/export and POST /api/studio-documents/import
 * (routes/studioDocuments/templateFile.mts): a template as a `.bftemplate`
 * file and back. DB-free: the store is a fake handed to the router factory, the
 * file code is the real one, the request goes through express for real.
 * Organisation isolation against the real store: tenantIsolation.matrix.test.js.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { makeTemplateFileRouter } = require('./templateFile.mts');

function fakeStore() {
    const docs = new Map();
    const created = [];
    docs.set('tpl-1', {
        id: 'tpl-1', userId: 'alice', name: 'Offer: Van Dijk', description: 'A quote', docType: 'quote', kind: 'template',
        bodyHtml: '<div class="doc-logo"></div><h1>{{customer}}</h1>', css: '.doc-logo { height: 20mm; }',
        settings: { contract: { parameters: [{ key: 'customer', type: 'text', label: 'Customer', required: true }] }, design: { accent: '#ff0000' },
            sampleValues: { customer: 'A real customer' } },
    });
    docs.set('deck-1', { id: 'deck-1', userId: 'alice', name: 'Deck', docType: 'presentation', bodyHtml: '# Deck\n## One\n![a](users/alice/a.png)', css: '', settings: {} });
    docs.set('sheet-1', { id: 'sheet-1', userId: 'alice', name: 'Sheet', docType: 'spreadsheet', bodyHtml: '', css: '', settings: {} });
    return {
        docs, created,
        async getDocument(id, userId) { const d = docs.get(id); return d && d.userId === userId ? d : null; },
        async createDocument(input) { const doc = { id: `new-${created.length + 1}`, ...input }; created.push(doc); return doc; },
    };
}

async function withServer(store, fn) {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    const requireAuth = (req, res, next) => {
        const user = req.headers['x-user'];
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        req.session = { user: { id: String(user) } };
        return next();
    };
    const imageResolver = () => async ({ storageKey }) => (storageKey === 'users/alice/a.png' ? 'data:image/png;base64,AAAA' : null);
    app.use('/api/studio-documents', makeTemplateFileRouter({ store: () => store, requireAuth, imageResolver }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/studio-documents`;
    const exportOf = async (id, user = 'alice') => {
        const res = await fetch(`${base}/${id}/export`, { headers: { 'x-user': user } });
        return { status: res.status, headers: res.headers, text: await res.text() };
    };
    const importOf = async (body, user = 'alice') => {
        const res = await fetch(`${base}/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    try { await fn({ exportOf, importOf }); } finally { server.close(); }
}

test('a template downloads as a .bftemplate file and imports back as a new private template of the importer', async () => {
    const store = fakeStore();
    await withServer(store, async ({ exportOf, importOf }) => {
        const out = await exportOf('tpl-1');
        assert.equal(out.status, 200);
        assert.match(out.headers.get('content-type'), /application\/vnd\.beeflow\.template\+json/);
        assert.match(out.headers.get('content-disposition'), /attachment; filename=".*\.bftemplate"/);
        const file = JSON.parse(out.text);
        assert.equal(file.format, 'beeflow-template');
        assert.doesNotMatch(out.text, /A real customer/, 'filled-in values never leave');

        const back = await importOf({ file }, 'carol');
        assert.equal(back.status, 201);
        const made = store.created[0];
        assert.equal(made.userId, 'carol');
        assert.equal(made.kind, 'template');
        assert.equal(made.visibility, 'private');
        assert.equal(made.bodyHtml, store.docs.get('tpl-1').bodyHtml, 'the styling comes along exactly');
        assert.equal(made.css, store.docs.get('tpl-1').css);
        assert.deepEqual(made.settings.design, { accent: '#ff0000' });
        assert.equal(made.settings.contract.parameters[0].key, 'customer');
        assert.equal(made.settings.sampleValues, undefined);
    });
});

test('a presentation file carries its pictures; a spreadsheet and a stranger\'s document are not exported', async () => {
    const store = fakeStore();
    await withServer(store, async ({ exportOf }) => {
        const deck = await exportOf('deck-1');
        assert.equal(deck.status, 200);
        assert.match(JSON.parse(deck.text).template.bodyHtml, /data:image\/png;base64,AAAA/);
        assert.equal(deck.headers.get('x-skipped-images'), '0');
        assert.equal((await exportOf('sheet-1')).status, 400);
        assert.equal((await exportOf('tpl-1', 'mallory')).status, 404);
    });
});

test('import refuses a file that is not a Bee Flow template, and says why', async () => {
    const store = fakeStore();
    await withServer(store, async ({ importOf }) => {
        const res = await importOf({ file: { format: 'something-else' } });
        assert.equal(res.status, 422);
        assert.match(res.body.error, /not a Bee Flow template file/);
        assert.equal((await importOf({ nope: true })).status, 400);
        assert.equal(store.created.length, 0);
    });
});
