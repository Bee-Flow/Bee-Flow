/**
 * fill_document — what reaches the PDF, and what reaches the run log.
 *
 * The cases worth pinning are the ones whose failure is a WRONG INVOICE rather
 * than an error: a list binding flattened into text on the way in (so the lines
 * table renders empty), a template belonging to somebody else, holes that
 * stayed empty with nobody told, and customer data landing in a run log that
 * BFSF-441 says may carry a reference and nothing more.
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/execFillDocument.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ── doubles ────────────────────────────────────────────────────────────────

const TEMPLATE = {
    id: 'doc_1',
    userId: 'user-1',
    name: 'Factuur',
    docType: 'invoice',
    bodyHtml: '<h1>{{customer.name}}</h1><table>{{#each lines}}<tr><td>{{description}}</td><td>{{amount}}</td></tr>{{/each}}</table><p>{{note}}</p>',
    css: '@page { size: A4; }',
    settings: {},
};

// A presentation template: an OUTLINE with the same placeholders.
const DECK = {
    id: 'deck_1',
    userId: 'user-1',
    name: 'Kwartaalcijfers',
    docType: 'presentation',
    bodyHtml: '# {{customer.name}}\n\n## Regels\n{{#each lines}}- {{description}}: {{amount}}\n{{/each}}\n\n## Noot\n{{note}}',
    css: '',
    settings: { deck: { preset: 'dark' } },
};

const documentStore = {
    created: [],
    async getDocumentVersion(id, userId) {
        if (userId !== 'user-1') return null;
        return id === TEMPLATE.id ? { ...TEMPLATE } : (id === DECK.id ? { ...DECK } : null);
    },
    async createDocument(doc) { documentStore.created.push(doc); return { ...doc, id: 'doc_copy' }; },
};

const renderCalls = [];
const renderFilled = {
    async renderFilledDocument(args) {
        renderCalls.push(args);
        const { fillDocumentBody } = require('../documents/documentTemplate');
        const fill = fillDocumentBody(args.document.bodyHtml, args.values, { escape: args.document.docType !== 'presentation' });
        if (args.document.docType === 'presentation') {
            const pdf = args.format === 'pdf';
            return {
                buffer: Buffer.from(pdf ? '%PDF-1.7 deck' : 'PK deck'),
                contentType: pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                extension: pdf ? 'pdf' : 'pptx', format: pdf ? 'pdf' : 'pptx', slideCount: 3,
                degraded: false, marking: null, fill,
            };
        }
        return {
            buffer: Buffer.from('%PDF-1.7 filled'),
            contentType: 'application/pdf',
            extension: 'pdf',
            degraded: false,
            marking: null,
            fill,
        };
    },
    documentFileName: (raw, fallback = 'document', ext = 'pdf') => `${String(raw || fallback).replace(/[\\/:*?"<>|;]/g, ' ').trim() || fallback}.${ext}`,
};

const storage = {
    uploads: [],
    isAvailable: () => true,
    buildAutomationFileKey: (userId, automationId, sha) => `auto/${automationId}/${sha}`,
    async uploadFile(key, buffer, contentType) { storage.uploads.push({ key, size: buffer.length, contentType }); },
};

const automationStore = {
    async getAutomation() { return null; },
    async recordGeneratedFile(row) { return { id: 'file-1', ...row }; },
};

const restore = installResolveStub({
    '../../stores/documentStore': documentStore,
    '../../stores/storageStore': storage,
    '../../stores/automationStore': automationStore,
    '../documents/renderFilledDocument': renderFilled,
});
const { execFillDocument, _test } = require('./execFillDocument');
after(() => restore());

const CTX = { orgId: 'org-1', userId: 'user-1', automationId: 'auto-7', runId: 'run-1' };
const RUN_STATE = {
    steps: {
        extract: { status: 'success', output: { naam: 'Van Dijk & Zn', nummer: '2026-014' } },
        rows: { status: 'success', output: { rows: [{ description: 'Werk', amount: '100,00' }, { description: 'Reis', amount: '25,00' }] } },
    },
};

const STEP = {
    id: 'fdoc_1',
    type: 'fill_document',
    documentId: 'doc_1',
    values: {
        'customer.name': '{{steps.extract.output.naam}}',
        lines: '{{steps.rows.output.rows}}',
    },
    fileName: 'Factuur {{steps.extract.output.nummer}}',
};

const run = (step = STEP, state = RUN_STATE, mode = 'live') => execFillDocument(step, CTX, state, mode);

// ── the binding rule ───────────────────────────────────────────────────────

test('a lone {{path}} keeps the REAL value, so a list arrives as a list', async () => {
    // The failure this prevents: interpolateTemplate JSON-stringifies an array,
    // so the lines block would receive text and render nothing — which looks
    // like a broken template and is actually a flattened binding.
    const { output } = await run();
    const values = renderCalls.at(-1).values;
    assert.ok(Array.isArray(values.lines), 'lines must arrive as an array');
    assert.strictEqual(values.lines.length, 2);
    assert.deepStrictEqual(output.missing, ['note']);
});

test('mixed text is still interpolated into a string', async () => {
    const step = { ...STEP, values: { 'customer.name': 'Klant {{steps.extract.output.naam}}' } };
    await run(step);
    assert.strictEqual(renderCalls.at(-1).values.customer.name, 'Klant Van Dijk & Zn');
});

test('dotted keys become the nested object the template looks up', () => {
    const values = _test.buildValues(
        { 'customer.name': '{{steps.extract.output.naam}}', 'customer.city': 'Utrecht' },
        RUN_STATE,
    );
    assert.deepStrictEqual(values, { customer: { name: 'Van Dijk & Zn', city: 'Utrecht' } });
});

test('a binding that resolves to nothing is left out, so the filler reports the hole', () => {
    const values = _test.buildValues({ 'customer.name': '{{steps.nope.output.x}}' }, RUN_STATE);
    assert.deepStrictEqual(values, {});
});

// ── the file ───────────────────────────────────────────────────────────────

test('the output is the same file shape generate_document produces', async () => {
    const { output } = await run();
    assert.strictEqual(output.fileId, 'file-1');
    assert.strictEqual(output.filename, 'Factuur 2026-014.pdf');
    assert.strictEqual(output.mimeType, 'application/pdf');
    assert.ok(output.size > 0);
    assert.strictEqual(output.documentId, 'doc_1');
    assert.strictEqual(output.documentName, 'Factuur');
});

test('without a fileName it falls back to the document\'s own name', async () => {
    const { output } = await run({ ...STEP, fileName: '' });
    assert.strictEqual(output.filename, 'Factuur.pdf');
});

test('the run log names the empty holes and carries none of the values', async () => {
    // BFSF-441: a run log gets a reference, never customer data.
    const { output } = await run();
    const serialised = JSON.stringify(output);
    assert.ok(serialised.includes('note'), 'the empty placeholder is named');
    assert.ok(!serialised.includes('Van Dijk'), 'the customer name must not reach the run log');
    assert.ok(!serialised.includes('100,00'), 'no amount may reach the run log');
});

// ── refusals ───────────────────────────────────────────────────────────────

test('a document belonging to someone else is not found, not forbidden', async () => {
    await assert.rejects(
        () => execFillDocument(STEP, { ...CTX, userId: 'someone-else' }, RUN_STATE, 'live'),
        (e) => e.errorClass === 'document_not_found',
    );
});

test('a step with no document selected refuses before anything is read', async () => {
    await assert.rejects(
        () => run({ ...STEP, documentId: '' }),
        (e) => e.errorClass === 'document_missing',
    );
});

test('unavailable file storage fails the step rather than losing the file silently', async () => {
    storage.isAvailable = () => false;
    try {
        await assert.rejects(() => run(), (e) => e.errorClass === 'storage_unavailable');
    } finally {
        storage.isAvailable = () => true;
    }
});

// ── dry run ────────────────────────────────────────────────────────────────

test('a dry run fills the template but renders, stores and bills nothing', async () => {
    const before = storage.uploads.length;
    const { output, dryRunSynthesised } = await run(STEP, RUN_STATE, 'dry_run');
    assert.strictEqual(dryRunSynthesised, true);
    assert.strictEqual(output.fileId, 'dry-run');
    assert.strictEqual(output.size, 0);
    assert.strictEqual(storage.uploads.length, before, 'nothing may be uploaded');
    // The point of a dry run here: which holes have no binding.
    assert.deepStrictEqual(output.missing, ['note']);
});

// ── the optional copy ──────────────────────────────────────────────────────

test('saveCopy keeps the FILLED body, not the template', async () => {
    documentStore.created.length = 0;
    const { output } = await run({ ...STEP, saveCopy: true, copyName: 'Factuur {{steps.extract.output.nummer}}' });
    assert.strictEqual(documentStore.created.length, 1);
    const copy = documentStore.created[0];
    assert.strictEqual(copy.name, 'Factuur 2026-014');
    assert.ok(copy.bodyHtml.includes('Van Dijk'), 'the copy holds the filled body');
    assert.ok(!copy.bodyHtml.includes('{{customer.name}}'), 'no placeholder may survive into the copy');
    assert.strictEqual(output.savedDocumentId, 'doc_copy');
});

test('a copy that cannot be saved never fails the step — the PDF already exists', async () => {
    const real = documentStore.createDocument;
    documentStore.createDocument = async () => { throw new Error('disk full'); };
    const warn = console.warn;
    console.warn = () => {};
    try {
        const { output } = await run({ ...STEP, saveCopy: true });
        assert.strictEqual(output.fileId, 'file-1');
        assert.strictEqual(output.savedDocumentId, undefined);
    } finally {
        documentStore.createDocument = real;
        console.warn = warn;
    }
});

test('no copy is kept unless it was asked for', async () => {
    documentStore.created.length = 0;
    await run();
    assert.strictEqual(documentStore.created.length, 0);
});

// ── a presentation template ────────────────────────────────────────────────

test('a presentation document fills into a .pptx by default and a PDF deck on request — outline filled as text, same file shape', async () => {
    renderCalls.length = 0;
    const { output } = await run({ ...STEP, documentId: 'deck_1', fileName: 'Cijfers {{steps.extract.output.nummer}}' });
    assert.strictEqual(output.filename, 'Cijfers 2026-014.pptx');
    assert.strictEqual(output.mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.strictEqual(output.format, 'pptx');
    assert.strictEqual(output.slideCount, 3);
    assert.deepStrictEqual(output.sourceHandle, { kind: 'generated_file', fileId: 'file-1' });
    assert.strictEqual(renderCalls.at(-1).format, 'pptx');
    assert.strictEqual(typeof renderCalls.at(-1).resolveImage, 'function', 'slide pictures resolve through the owner');
    assert.strictEqual(renderCalls.at(-1).fill, undefined);
    const pdf = await run({ ...STEP, documentId: 'deck_1', format: 'pdf', fileName: '' });
    assert.strictEqual(pdf.output.filename, 'Kwartaalcijfers.pdf', 'the presentation\'s own name, with the PDF extension');
    assert.strictEqual(pdf.output.mimeType, 'application/pdf');
    assert.strictEqual(pdf.output.format, 'pdf');
    // The ampersand in the customer name reaches the outline unescaped.
    const { fillDocumentBody } = require('../documents/documentTemplate');
    const fill = fillDocumentBody(DECK.bodyHtml, _test.buildValues(STEP.values, RUN_STATE), { escape: false });
    assert.match(fill.bodyHtml, /^# Van Dijk & Zn/);
    // A dry run says which file it WOULD make.
    const dry = await run({ ...STEP, documentId: 'deck_1' }, RUN_STATE, 'dry_run');
    assert.strictEqual(dry.output.filename, 'Factuur 2026-014.pptx');
    assert.strictEqual(dry.output.mimeType, output.mimeType);
    // A page ignores the format.
    const page = await run({ ...STEP, format: 'pptx' });
    assert.strictEqual(page.output.filename, 'Factuur 2026-014.pdf');
    assert.strictEqual(page.output.format, 'pdf');
});

test('saveCopy on a presentation keeps the FILLED outline as a presentation', async () => {
    documentStore.created.length = 0;
    await run({ ...STEP, documentId: 'deck_1', saveCopy: true });
    assert.strictEqual(documentStore.created.length, 1);
    const copy = documentStore.created[0];
    assert.strictEqual(copy.docType, 'presentation');
    assert.match(copy.bodyHtml, /^# Van Dijk & Zn/);
    assert.deepStrictEqual(copy.settings.deck, { preset: 'dark' }, 'the look rides along');
});
