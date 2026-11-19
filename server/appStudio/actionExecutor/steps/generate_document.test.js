'use strict';
/**
 * The App Studio step `generate_document`: bindings resolved, the renderer called once with the
 * content, title and format, the AI marking only on `aiGenerated`, what the FILE carries recorded,
 * the attachment tail handed the step (attachToRecordId / attachToFieldKey travel with it), and
 * the renderer's refusals as step failures. The renderer and the store are stubbed; the last test
 * runs the real renderer with no browser and checks the pdfkit fallback still gives a PDF.
 * Run: cd server && node --test appStudio/actionExecutor/steps/generate_document.test.js
 */

require('../../../boot/featureModules'); // core looks feature modules up by name (core/featureModules.js)
const { test } = require('node:test');
const assert = require('node:assert');

// No browser: the provider's own seam makes the runner report none, as on a stack without it.
require('../../../services/browserProvider.js').__setDepsForTests({
    pwtRunner: { getBrowserEndpoint: async () => { throw new Error('no browser runner in this test'); } },
});

const { runGenerateDocument, documentFileName } = require('./generate_document.mts');

const app = { id: 'app1', userId: 'owner', organizationId: 'org1' };
const MARKING = { enabled: true, footer_text: 'Generated with AI — Org', org_name: 'Org', generated_at: '2026-01-01T00:00:00.000Z', ai_step_ids: [] };

function harness({ render, marking = MARKING, docxStyle = { css: '', opts: {}, inline: {} } } = {}) {
    const seen = { renders: [], stores: [], markingAsked: [], styleAsked: [], warnings: [] };
    const deps = {
        // A binding here is { value } so the test sees what was resolved.
        resolve: (binding) => (binding && typeof binding === 'object' ? binding.value : undefined),
        render: async (input) => {
            seen.renders.push(input);
            if (render) return render(input);
            return { buffer: Buffer.from('%PDF-1.7 x'), contentType: input.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf', degraded: false, marking: input.marking ? { visible: true, metadata: true } : null };
        },
        resolveMarking: async (orgId) => { seen.markingAsked.push(orgId); return marking; },
        docxStyle: async (orgId) => { seen.styleAsked.push(orgId); return docxStyle; },
        store: async (input) => {
            seen.stores.push(input);
            return { ok: true, result: { kind: 'studio_attachment', fileId: 'att1', name: input.fileName, mime: input.contentType, size: input.buffer.length, ...input.extra } };
        },
        log: { warn: (m) => seen.warnings.push(m) },
    };
    return { seen, deps };
}

test('renders the content into a PDF and stores it as an attachment of the app', async () => {
    const { seen, deps } = harness();
    const step = {
        kind: 'generate_document', content: { value: '# Report\n\nAll good.' }, title: { value: 'Q3 report' },
        fileName: { value: 'Report 42' }, attachToRecordId: { value: 'rec_1' }, attachToFieldKey: 'report', resultVar: 'doc',
    };
    const out = await runGenerateDocument(app, step, {}, deps);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(seen.renders, [{ content: '# Report\n\nAll good.', contentFormat: 'markdown', title: 'Q3 report', format: 'pdf', marking: null, docxStyle: null }]);
    assert.deepStrictEqual(seen.markingAsked, [], 'no marking asked without aiGenerated');
    assert.deepStrictEqual(seen.styleAsked, [], 'a PDF asks no Word house style');
    const stored = seen.stores[0];
    assert.strictEqual(stored.fileName, 'Report 42.pdf');
    assert.strictEqual(stored.step, step, 'the tail reads attachToRecordId / attachToFieldKey from the step');
    assert.strictEqual(stored.app, app);
    assert.deepStrictEqual(out.result, {
        kind: 'studio_attachment', fileId: 'att1', name: 'Report 42.pdf', mime: 'application/pdf', size: 10,
        format: 'pdf', marked: false, marking: { requested: false, visible: false, metadata: false },
    });
});

test('an ai_generate result is read as its text, and aiGenerated asks the owner organisation for the marking', async () => {
    const { seen, deps } = harness();
    const out = await runGenerateDocument(app, {
        content: { value: { text: 'A summary.', citations: [] } }, fileName: { value: 'Summary' }, aiGenerated: true, resultVar: 'doc',
    }, { orgId: 'viewer-org' }, deps);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(seen.renders[0].content, 'A summary.');
    assert.deepStrictEqual(seen.markingAsked, ['org1'], 'the app owner organisation decides, not the viewer');
    assert.strictEqual(seen.renders[0].marking, MARKING);
    assert.strictEqual(out.result.marked, true);
    assert.deepStrictEqual(out.result.marking, { requested: true, visible: true, metadata: true });
});

test('records what the file carries: a marking the renderer dropped is not marked', async () => {
    const { seen, deps } = harness({ render: () => ({ buffer: Buffer.from('%PDF'), contentType: 'application/pdf', degraded: false, marking: null }) });
    const out = await runGenerateDocument(app, { content: { value: 'x' }, fileName: { value: 'f' }, aiGenerated: true }, {}, deps);
    assert.strictEqual(out.result.marked, false);
    assert.deepStrictEqual(out.result.marking, { requested: true, visible: false, metadata: false });
    assert.ok(seen.warnings.some((w) => w.includes('NOT marked')));
});

test('a marking that cannot be resolved renders unmarked and says so', async () => {
    const { seen, deps } = harness();
    deps.resolveMarking = async () => { throw new Error('compliance down'); };
    const out = await runGenerateDocument(app, { content: { value: 'x' }, fileName: { value: 'f' }, aiGenerated: true }, {}, deps);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(seen.renders[0].marking, null);
    assert.ok(seen.warnings.some((w) => w.includes('rendering unmarked')));
});

test('a Word file wears the Word house style unless houseStyle is false', async () => {
    const style = { css: 'h1{}', opts: { font: 'Arial' }, inline: {} };
    const { seen, deps } = harness({ docxStyle: style });
    const out = await runGenerateDocument(app, { content: { value: 'x' }, format: 'docx', fileName: { value: 'Letter.docx' } }, {}, deps);
    assert.strictEqual(seen.renders[0].format, 'docx');
    assert.strictEqual(seen.renders[0].docxStyle, style);
    assert.deepStrictEqual(seen.styleAsked, ['org1']);
    assert.strictEqual(out.result.name, 'Letter.docx', 'the extension is not doubled');
    await runGenerateDocument(app, { content: { value: 'x' }, format: 'docx', houseStyle: false, fileName: { value: 'L' } }, {}, deps);
    assert.strictEqual(seen.renders[1].docxStyle, null);
    assert.strictEqual(seen.styleAsked.length, 1);
});

test('the renderer refusals come back as step failures with their code', async () => {
    const { deps } = harness({ render: () => { throw Object.assign(new Error('The content is 3000000 characters; the limit is 2000000.'), { errorClass: 'document_too_large' }); } });
    const out = await runGenerateDocument(app, { content: { value: 'x' }, fileName: { value: 'f' } }, {}, deps);
    assert.deepStrictEqual(out, { ok: false, error: 'The content is 3000000 characters; the limit is 2000000.', code: 'document_too_large' });
    const none = await runGenerateDocument(app, { content: { value: { rows: [] } }, fileName: { value: 'f' } }, {}, harness().deps);
    assert.strictEqual(none.ok, false);
    assert.strictEqual(none.code, 'document_empty');
});

test('the file name is safe in a header and falls back to the title, then "document"', () => {
    assert.strictEqual(documentFileName('a/b\\c"d\r\ne:f;g', 'document'), 'abcdefg');
    assert.strictEqual(documentFileName('Report.PDF', 'document'), 'Report');
    assert.strictEqual(documentFileName('   ', 'document'), 'document');
});

test('without a browser the real renderer still returns a PDF, flagged degraded', async () => {
    const { seen, deps } = harness();
    deps.render = (input) => require('../../../core/documents/render/documentRenderer').renderDocument(input);
    const out = await runGenerateDocument(app, { content: { value: '# Letter\n\nDear reader,\n\n- one\n- two' }, title: { value: 'Letter' }, fileName: { value: 'Letter' } }, {}, deps);
    assert.strictEqual(out.ok, true);
    const stored = seen.stores[0];
    assert.strictEqual(stored.buffer.subarray(0, 5).toString(), '%PDF-');
    assert.strictEqual(stored.contentType, 'application/pdf');
    assert.strictEqual(out.result.degraded, true);
    assert.ok(seen.warnings.some((w) => w.includes('plain fallback layout')));
});
