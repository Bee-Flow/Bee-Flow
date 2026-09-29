/**
 * Studio Documents and its licence (`studio_documents`, the enterprise split
 * of 2026-10).
 *
 * The line routes/studioDocuments.js draws, pinned from both sides:
 *   - MAKING and CHANGING a document is refused without the capability, with
 *     the standard 403 body, before anything is written;
 *   - what somebody already made keeps working: reading, the preview,
 *     validating, the PDF and .pptx downloads, the version list, the house
 *     style, and archiving (removing is never a paid act);
 *   - GET /:id says `editable: false`, so an editor opens read-only instead
 *     of autosaving into a 403;
 *   - a malformed body is still a 400 that never reaches the licence check.
 *
 * The real router behind a real express app; the gate is the injected
 * entitlements double below, which answers like requireCapability does.
 *
 * Run: cd server && node --test routes/studioDocuments.licence.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');
const { starters } = require('../core/documents/documentStarters');

const USER = { id: 'u1', organizationId: 'org1' };
const SAMPLE = { 'customer.name': 'Customer', date: '2026-09-17', summary: 'Verified facts', remoteAccess: false, cloudServices: false };
const doc = { ...starters().find(s => s.id === 'security'), id: 'doc', userId: 'u1', versionId: 'v1', kind: 'document', visibility: 'private' };
doc.settings = { ...doc.settings, sampleValues: SAMPLE };
const deck = {
    id: 'deck', userId: 'u1', versionId: 'v1', kind: 'document', docType: 'presentation', name: 'Kick-off', visibility: 'private',
    bodyHtml: '# Kick-off\n\n## Goals\n- a\n- b', css: '', settings: { deck: { preset: 'dark' }, sampleValues: {} },
};
const byId = { doc, deck };

// What reached the store, and what the gate was asked.
let writes = [];
let gateAsked = [];
let licensed = new Set();

const store = {
    MAX_HTML_BYTES: 512 * 1024,
    DOC_TYPES: ['invoice', 'quote', 'letter', 'report', 'security', 'document', 'presentation'],
    getDocument: async (id, user) => (byId[id] && user === byId[id].userId ? structuredClone(byId[id]) : null),
    getDocumentVersion: async (id, user) => (byId[id] && user === byId[id].userId ? structuredClone(byId[id]) : null),
    listDocuments: async () => [{ id: 'doc', name: doc.name }],
    listTemplates: async () => [],
    listFolders: async () => [{ id: 'f1', name: 'Invoices', parentId: null }],
    listVersions: async () => [{ id: 'v1' }],
    createDocument: async (input) => { writes.push(['createDocument', input.name]); return { ...input, id: 'new' }; },
    updateDocument: async (id) => { writes.push(['updateDocument', id]); return structuredClone(byId[id]); },
    restoreVersion: async (id) => { writes.push(['restoreVersion', id]); return structuredClone(byId[id]); },
    deleteDocument: async (id) => { writes.push(['deleteDocument', id]); return true; },
    createFolder: async (_u, name) => { writes.push(['createFolder', name]); return { id: 'f2', name }; },
    deleteFolder: async (_u, id) => { writes.push(['deleteFolder', id]); },
};

const entitlements = {
    requireCapability: (capId) => (req, res, next) => {
        gateAsked.push(capId);
        if (licensed.has(capId)) return next();
        return res.status(403).json({ error: 'feature_locked', feature: capId, required: 'enterprise', current: 'community' });
    },
    hasCapability: async (capId) => licensed.has(capId),
};

const restore = installResolveStub({
    '../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
        requirePermission: () => (_req, _res, next) => next(),
        hasPermission: async () => false,
    },
    '../stores/documentStore': store,
    '../core/entitlements/entitlements': entitlements,
    '../core/documents/renderFilledDocument': {
        houseStyleCssFor: async () => '',
        renderFilledDocument: async ({ format }) => (format === 'pptx'
            ? { buffer: Buffer.from('PK'), contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
            : { buffer: Buffer.from('%PDF-'), contentType: 'application/pdf' }),
    },
    '../compliance/marking': { resolveMarking: async () => null },
    './browserProvider': { withContext: async () => { throw new Error('no browser in this test'); } },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => {} },
});
test.after(restore);

const h = require('../core/http/routeHarness');
const api = h.serve('/api/studio-documents', require('./studioDocuments'), { user: USER });
test.after(api.close);

test.beforeEach(() => { writes = []; gateAsked = []; licensed = new Set(); });

const call = (method, path, body) => api.call(method, `/api/studio-documents${path}`, { body });

// Every route that MAKES or CHANGES something, with a body its schema accepts.
const WRITES = [
    ['POST', '', { name: 'Offerte' }],
    ['POST', '/folders', { name: 'Offertes' }],
    ['PATCH', '/doc', { bodyHtml: '<p>x</p>', expectedVersionId: 'v1' }],
    ['POST', '/doc/duplicate', { kind: 'template' }],
    ['POST', '/doc/sections/remote/save', {}],
    ['POST', '/doc/insert-section', { sourceId: 'doc', expectedVersionId: 'v1' }],
    ['POST', '/doc/review-update', { sectionId: 'remote' }],
    ['POST', '/doc/preview-changes', { design: {} }],
    ['POST', '/doc/ai-proposal', { message: 'Make the header blue' }],
    ['POST', '/deck/preview', { bodyHtml: '# Other\n\n## X\n- 1' }],
    ['POST', '/doc/versions/v0/restore', { expectedVersionId: 'v1' }],
];

test('without Studio Documents, making or changing a document is refused before anything is written', async () => {
    for (const [method, path, body] of WRITES) {
        const res = await call(method, path, body);
        const what = `${method} ${path || '/'}`;
        assert.equal(res.status, 403, `${what} → ${res.text}`);
        assert.equal(res.body.error, 'feature_locked', what);
        assert.equal(res.body.feature, 'studio_documents', what);
    }
    assert.deepEqual(writes, [], 'no refused request reached the store');
    assert.ok(gateAsked.length >= WRITES.length && gateAsked.every(id => id === 'studio_documents'));
});

test('without it, what somebody already made keeps working: read, preview, validate, download, history, archive', async () => {
    const list = await call('GET', '');
    assert.equal(list.status, 200, list.text);

    const one = await call('GET', '/doc');
    assert.equal(one.status, 200, one.text);
    assert.equal(one.body.document.editable, false, 'the editor opens read-only');

    const preview = await call('GET', '/doc/preview');
    assert.equal(preview.status, 200, preview.text);
    assert.match(preview.headers.get('content-type'), /text\/html/);

    const checked = await call('POST', '/doc/validate', { values: SAMPLE });
    assert.equal(checked.status, 200, checked.text);

    const pdf = await call('GET', '/doc/pdf');
    assert.equal(pdf.status, 200, pdf.text);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');

    const pptx = await call('GET', '/deck/pptx');
    assert.equal(pptx.status, 200, pptx.text);
    assert.match(pptx.headers.get('content-type'), /presentationml/);

    assert.equal((await call('GET', '/doc/versions')).status, 200);
    assert.equal((await call('GET', '/folders')).status, 200);
    assert.equal((await call('GET', '/templates')).status, 200);
    assert.equal((await call('GET', '/house-style')).status, 200, 'the letterhead is the organisation\'s, not the feature\'s');

    assert.deepEqual(gateAsked, [], 'no read asked the write gate');
});

test('without it, archiving a document and deleting a folder are never refused', async () => {
    const archived = await call('DELETE', '/doc');
    assert.equal(archived.status, 200, archived.text);
    const folder = await call('DELETE', '/folders/f1');
    assert.equal(folder.status, 200, folder.text);
    assert.deepEqual(writes, [['deleteDocument', 'doc'], ['deleteFolder', 'f1']]);
    assert.deepEqual(gateAsked, []);
});

test('with Studio Documents the same writes go through, and the document is editable', async () => {
    licensed = new Set(['studio_documents']);
    const created = await call('POST', '', { name: 'Offerte' });
    assert.equal(created.status, 201, created.text);
    const saved = await call('PATCH', '/doc', { bodyHtml: '<p>x</p>', expectedVersionId: 'v1' });
    assert.equal(saved.status, 200, saved.text);
    const folder = await call('POST', '/folders', { name: 'Offertes' });
    assert.equal(folder.status, 201, folder.text);
    assert.deepEqual(writes, [['createDocument', 'Offerte'], ['updateDocument', 'doc'], ['createFolder', 'Offertes']]);

    const one = await call('GET', '/doc');
    assert.equal(one.body.document.editable, true);
});

test('a malformed body is still a 400 that never reaches the licence check', async () => {
    const res = await call('POST', '/doc/duplicate', { kind: 'copy' });
    h.assertRefused(assert, res, 'body.kind');
    assert.deepEqual(gateAsked, []);
});
