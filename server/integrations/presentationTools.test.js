/**
 * create_presentation — the chat's .pptx tool. Pinned here: where the file
 * lands (the caller's own storage prefix, served by the storage proxy), the
 * link the model is told to write, filename sanitising, and the two refusals
 * (no content, no storage).
 *
 * DB-free: storage and config are stubbed.
 *
 * Run: node --test --test-force-exit integrations/presentationTools.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');

const uploads = [];
const storage = {
    available: true,
    isAvailable: () => storage.available,
    buildKey: (userId, category, filename) => `users/${userId}/${category}/${filename}`,
    buildProxyUrl: (key) => `/api/storage/file/${key.split('/').map(encodeURIComponent).join('/')}`,
    uploadFile: async (key, buffer, contentType) => { uploads.push({ key, size: buffer.length, contentType }); },
};
const library = [];
installResolveStub({
    '../stores/storageStore': storage,
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => {} },
    // The library the deck is also kept in (core/documents/deckDocument.js).
    '../../stores/documentStore': {
        createDocument: async (input) => { if (library.fail) throw new Error('library down'); library.push(input); return { id: `doc-${library.length}`, name: input.name, versionId: 'v1' }; },
    },
});

const { executePresentationTool, PRESENTATION_TOOLS, isPresentationTool, safePresentationFileName } = require('./presentationTools');

test('the tool schema spreads the shared deck inputs and requires only a title', () => {
    const fn = PRESENTATION_TOOLS[0].function;
    assert.strictEqual(fn.name, 'create_presentation');
    assert.deepStrictEqual(fn.parameters.required, ['title']);
    for (const k of ['title', 'subtitle', 'slides', 'markdown', 'fileName', 'houseStyle']) assert.ok(fn.parameters.properties[k], k);
    assert.strictEqual(isPresentationTool('create_presentation'), true);
    assert.strictEqual(isPresentationTool('nextcloud_create_presentation'), false);
});

test('a structured deck is built, stored under the user\'s own prefix and linked in the message', async () => {
    uploads.length = 0;
    const res = await executePresentationTool({
        title: 'Kwartaalcijfers Q3',
        slides: [{ title: 'Omzet', bullets: ['Groei 12%'], notes: 'zeg dit' }, { title: 'Quote', quote: 'Wij groeien door.' }],
    }, { userId: 'u1', orgId: null });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.filename, 'Kwartaalcijfers-Q3.pptx');
    assert.strictEqual(res.slideCount, 3);
    assert.match(res.downloadUrl, /^\/api\/storage\/file\/users\/u1\/presentations\/\d+_[0-9a-f]{6}_Kwartaalcijfers-Q3\.pptx$/);
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(uploads[0].contentType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.ok(uploads[0].size > 1000 && res.size === uploads[0].size);
    assert.match(res.message, /\[Kwartaalcijfers-Q3\.pptx\]\(\/api\/storage\/file\/users\/u1\/presentations\//);
    assert.strictEqual(res.houseStyle, false);
    assert.strictEqual(res.marking, null);
});

test('a markdown outline works too, and deck warnings are surfaced to the model', async () => {
    const res = await executePresentationTool({
        title: 'Outline', markdown: '# Outline\n\n## One\n- a\n\n![x](https://example.com/x.png)',
    }, { userId: 'u1' });
    assert.strictEqual(res.success, true);
    assert.ok(res.warnings.some((w) => /example\.com/.test(w)));
    assert.match(res.message, /Notes: remote image/);
});

test('filename: the caller\'s name wins, traversal and non-ASCII never reach the key', async () => {
    const res = await executePresentationTool({ title: 'T', fileName: '../../résumé déck.pptx', slides: [{ title: 'a' }] }, { userId: 'u1' });
    assert.strictEqual(res.filename, 'resume-deck.pptx');
    assert.ok(!res.downloadUrl.includes('..'));
    assert.strictEqual(safePresentationFileName(''), 'presentation.pptx');
    assert.strictEqual(safePresentationFileName('q3-review.pptx'), 'q3-review.pptx');
    assert.strictEqual(safePresentationFileName('..hidden'), 'hidden.pptx');
});

test('refusals: no content, no user, no storage — each a message the model can act on', async () => {
    const noContent = await executePresentationTool({ title: 'T' }, { userId: 'u1' });
    assert.match(noContent.error, /`slides`.*`markdown`/);
    const noUser = await executePresentationTool({ title: 'T', slides: [{ title: 'a' }] }, {});
    assert.match(noUser.error, /user context/);
    storage.available = false;
    try {
        const noStorage = await executePresentationTool({ title: 'T', slides: [{ title: 'a' }] }, { userId: 'u1' });
        assert.match(noStorage.error, /nextcloud_create_presentation/);
    } finally {
        storage.available = true;
    }
});

test('a deck the model made too big is an error, not a crash', async () => {
    const res = await executePresentationTool({
        title: 'Huge', slides: Array.from({ length: 70 }, (_, i) => ({ title: `s${i}` })),
    }, { userId: 'u1' });
    assert.match(res.error, /limit is 60/);
});

test('the deck is also kept in Studio → Documents as a presentation: the outline, its look, and a link the model is told to give', async () => {
    library.length = 0;
    const res = await executePresentationTool({
        title: 'Roadmap', slides: [{ title: 'Q4', bullets: ['ship', 'learn'], notes: 'n' }], theme: { preset: 'bold', footerText: 'Intern' },
    }, { userId: 'u1' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.documentId, 'doc-1');
    assert.strictEqual(res.documentUrl, '/app/studio/documents/doc-1');
    assert.strictEqual(res.file.documentId, 'doc-1');
    assert.match(res.message, /\[Roadmap\]\(\/app\/studio\/documents\/doc-1\)/);
    assert.match(res.message, /\[Roadmap\.pptx\]\(\/api\/storage\/file\//);
    const doc = library[0];
    assert.strictEqual(doc.userId, 'u1');
    assert.strictEqual(doc.docType, 'presentation');
    assert.match(doc.bodyHtml, /^# Roadmap\n\n## Q4\n- ship\n- learn\n<!-- notes: n -->/);
    assert.deepStrictEqual(doc.settings.deck, { preset: 'bold', footerText: 'Intern' });
    assert.strictEqual(doc.settings.generatedFrom.source, 'create_presentation');
    // Opting out, and a library that is down: the file still comes back.
    const off = await executePresentationTool({ title: 'Once', slides: [{ title: 'a' }], saveToLibrary: false }, { userId: 'u1' });
    assert.strictEqual(off.documentId, undefined);
    assert.strictEqual(library.length, 1);
    library.fail = true;
    const warn = console.warn; console.warn = () => {};
    try {
        const down = await executePresentationTool({ title: 'Still', slides: [{ title: 'a' }] }, { userId: 'u1' });
        assert.strictEqual(down.success, true);
        assert.strictEqual(down.documentId, undefined);
        assert.match(down.message, /Reply with the download link/);
    } finally { library.fail = false; console.warn = warn; }
});
