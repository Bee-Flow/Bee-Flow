'use strict';
/**
 * copy_document: a copy in the OWNER's library, read through the app's
 * document pool like any document component, marked as made by this app, and
 * — for a presentation with a template — wearing the template's look.
 *
 * Run: cd server && node --test appStudio/actionExecutor/copyDocumentStep.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { copyDocumentStep, copyName, copySettings } = require('./copyDocumentStep.mts');

const APP = { id: 'app1', userId: 'owner', organizationId: 'org1' };
const doc = (id, extra = {}) => ({ id, userId: 'owner', organizationId: 'org1', name: `Doc ${id}`, docType: 'presentation', kind: 'document', bodyHtml: '# T\n\n## A\n- one\n', css: '', settings: { deck: { preset: 'band' }, sampleValues: { a: 1 } }, versionId: `v-${id}`, ...extra });
const DOCS = {
    deck1: doc('deck1'),
    tpl: doc('tpl', { settings: { deck: { preset: 'minimal', accent: '#112233' }, houseStyle: false } }),
    page1: doc('page1', { docType: 'page', bodyHtml: '<p>x</p>', settings: {} }),
    sheet1: doc('sheet1', { docType: 'spreadsheet', settings: {} }),
    foreign: doc('foreign', { userId: 'colleague', sharingRole: 'viewer' }),
    loose: doc('loose'),
};
let created;
const deps = () => ({
    resolveBinding: (b) => (b && typeof b === 'object' && b.kind === 'static' ? b.value : b ?? null),
    buildServerScope: () => ({}),
    reader: {
        getDocument: async (id, userId) => { assert.strictEqual(userId, 'owner', 'read as the owner'); return DOCS[id] || null; },
        getDocumentVersion: async (id) => (DOCS[id] ? { ...DOCS[id], versionId: 'v-old' } : null),
    },
    createDocument: async (input) => { created.push(input); return { ...input, id: 'copy1', versionId: 'v-copy1' }; },
});
const pool = { ids: new Set(['deck1', 'tpl', 'page1', 'sheet1', 'foreign']), folderIds: new Set() };
const run = (step, ctx = { documentPool: pool }) => copyDocumentStep(APP, null, { kind: 'copy_document', resultVar: 'copy', ...step }, ctx, deps());
const src = (id) => ({ kind: 'static', value: id });

test.beforeEach(() => { created = []; });

test('a deck copied with a template takes the template\'s look and keeps its own outline', async () => {
    const out = await run({ source: src('deck1'), templateDocumentId: 'tpl', name: src('New look') });
    assert.deepStrictEqual(out, { ok: true, result: { kind: 'studio_document', documentId: 'copy1', versionId: 'v-copy1', name: 'New look', docType: 'presentation', sourceDocumentId: 'deck1', templateDocumentId: 'tpl' } });
    const [input] = created;
    assert.strictEqual(input.userId, 'owner');
    assert.strictEqual(input.visibility, 'private');
    assert.strictEqual(input.bodyHtml, DOCS.deck1.bodyHtml);
    assert.deepStrictEqual(input.settings.deck, { preset: 'minimal', accent: '#112233' });
    assert.strictEqual(input.settings.houseStyle, false);
    assert.strictEqual(input.settings.createdByApp, 'app1');
    assert.deepStrictEqual(input.settings.source, { documentId: 'deck1', versionId: 'v-deck1' });
    assert.ok(!('sampleValues' in input.settings), 'the source\'s sample values stay with the source');
});

test('a plain copy keeps the look and is named after its source', async () => {
    const out = await run({ source: src('page1') });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(created[0].name, 'Doc page1 — copy');
    assert.strictEqual(created[0].docType, 'page');
});

test('refused: outside the pool, shared with the owner, a spreadsheet, a template on a page, no pool at all', async () => {
    assert.deepStrictEqual(await run({ source: src('loose') }), { ok: false, error: 'This document is not available in this app.', code: 'document_not_found' });
    assert.strictEqual((await run({ source: src('foreign') })).code, 'document_not_found');
    assert.strictEqual((await run({ source: src('sheet1') })).code, 'sheet_copy_unavailable');
    assert.strictEqual((await run({ source: src('page1'), templateDocumentId: 'tpl' })).code, 'template_not_deck');
    assert.strictEqual((await run({ source: src('deck1') }, {})).code, 'documents_unavailable', 'the public route builds no pool');
    assert.strictEqual((await run({ source: src('') })).code, 'document_missing');
    assert.deepStrictEqual(created, [], 'nothing was created');
});

test('copyName and copySettings', () => {
    assert.strictEqual(copyName('  a\nb  ', 'x'), 'a b');
    assert.strictEqual(copyName('', 'fallback'), 'fallback');
    assert.strictEqual(copyName('x'.repeat(300), 'f').length, 200);
    const s = copySettings({ id: 'd', versionId: 'v', settings: { createdByApp: 'other', sectionOverrides: {}, keep: 1 } }, 'app9');
    assert.deepStrictEqual(s, { keep: 1, source: { documentId: 'd', versionId: 'v' }, createdByApp: 'app9' });
});
