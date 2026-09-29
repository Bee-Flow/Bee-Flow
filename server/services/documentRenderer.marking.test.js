/**
 * documentRenderer — AI content marking (Art. 50(2)): the visible footer in
 * every path, the PDF Info keys, the pdf-lib absence path, DOCX properties.
 * Run: node --test --test-force-exit server/services/documentRenderer.marking.test.js
 *
 * The pdf-lib absence test runs FIRST on purpose: Node's per-parent resolve
 * cache means a require('pdf-lib') that once succeeded from documentRenderer
 * can no longer be made to fail from a test.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const { installResolveStub } = require('../testUtils/stubRequire');

// The browser is a stand-in: "unavailable" (→ pdfkit fallback) or "returns a
// PDF" (any bytes — here a pdfkit document so pdf-lib can load them).
const browser = { mode: 'unavailable', lastPdfOptions: null, lastHtml: null };
const browserProvider = {
    withContext: async (_opts, fn) => {
        if (browser.mode === 'unavailable') throw new Error('pwt-runner not reachable');
        const page = {
            setDefaultTimeout() {},
            async setContent(html) { browser.lastHtml = html; },
            async pdf(options) { browser.lastPdfOptions = options; return renderer._test.renderPdfViaPdfkit('browser body', { title: 'From browser' }); },
        };
        return fn({ newPage: async () => page });
    },
};
const restore = installResolveStub({ './browserProvider': browserProvider });
const renderer = require('./documentRenderer');
after(() => restore());

const MARKING = {
    enabled: true,
    org_name: 'Acme BV',
    provider: 'claude',
    generated_at: '2026-09-14T09:00:00.000Z',
    automation_id: 'auto-7',
    ai_step_ids: ['ai_1'],
    footer_text: 'Gegenereerd met AI — Acme BV',
    locale: 'nl',
};
const KEYWORDS = ['AIGenerated=true', 'AIProvider=claude', 'GeneratedAt=2026-09-14T09:00:00.000Z', 'BeeFlowAutomation=auto-7'];

async function readPdfInfo(buffer) {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    return { title: doc.getTitle(), author: doc.getAuthor(), subject: doc.getSubject(), keywords: doc.getKeywords(), producer: doc.getProducer() };
}

test('pdf-lib absent: the browser PDF still ships with the visible line, result says metadata:false', async () => {
    const original = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === 'pdf-lib') { const e = new Error("Cannot find module 'pdf-lib'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
        return original.call(this, request, ...rest);
    };
    try {
        browser.mode = 'ok';
        const out = await renderer.renderDocument({ content: '# Hallo\n\ntekst', title: 'Brief', marking: MARKING });
        assert.strictEqual(out.format, 'pdf');
        assert.strictEqual(out.degraded, false);
        assert.deepStrictEqual(out.marking, { visible: true, metadata: false });
        assert.ok(Buffer.isBuffer(out.buffer) && out.buffer.length > 0);
        assert.ok(browser.lastHtml.includes('Gegenereerd met AI — Acme BV'), 'visible line in the printed HTML');
        assert.ok(browser.lastPdfOptions.footerTemplate.includes('Gegenereerd met AI — Acme BV'), 'visible line in the page footer');
    } finally {
        Module._resolveFilename = original;
    }
});

test('buildPrintHtml: trailing <footer class="ai-mark"> only when marked, text escaped', () => {
    const plain = renderer._test.buildPrintHtml('<p>x</p>', { title: 'T' });
    assert.ok(!plain.includes('<footer class="ai-mark"'));
    const marked = renderer._test.buildPrintHtml('<p>x</p>', { title: 'T', marking: { ...MARKING, footer_text: 'AI <b>& co</b>' } });
    assert.ok(marked.includes('</main><footer class="ai-mark"><p class="ai-mark">AI &lt;b&gt;&amp; co&lt;/b&gt;</p></footer></body>'));
    assert.ok(marked.includes('.ai-mark {'));
    assert.strictEqual(renderer._test.markingFooterHtml(null), '');
    assert.strictEqual(renderer._test.markingFooterHtml({ enabled: false, footer_text: 'x' }), '');
    assert.strictEqual(renderer._test.markingText({ footer_text: '  hi  ' }), 'hi');
});

test('buildSlidesHtml: the marking line is a position:fixed footer repeated on every landscape page', () => {
    const html = renderer._test.buildSlidesHtml('<h1>Deck</h1><h2>One</h2><p>a</p>', { title: 'Deck', marking: MARKING });
    assert.ok(html.includes('<footer class="ai-mark"><p class="ai-mark">Gegenereerd met AI — Acme BV</p></footer></body>'));
    assert.match(html, /\.ai-mark \{ position: fixed;/);
    assert.ok(!renderer._test.buildSlidesHtml('<h2>One</h2>', { title: 'Deck' }).includes('<footer class="ai-mark"'));
});

test('browserFooterTemplate: marking text left of the page counter; counter alone when unmarked', () => {
    const marked = renderer._test.browserFooterTemplate(MARKING);
    assert.ok(marked.indexOf('Gegenereerd met AI — Acme BV') < marked.indexOf('class="pageNumber"'));
    assert.ok(marked.includes('class="totalPages"'));
    const plain = renderer._test.browserFooterTemplate(null);
    assert.ok(plain.includes('class="pageNumber"') && !plain.includes('flex:1'));
    assert.deepStrictEqual(renderer._test.markingKeywords(MARKING), KEYWORDS);
    assert.deepStrictEqual(renderer._test.markingKeywords({ generated_at: 'x' }), ['AIGenerated=true', 'AIProvider=unknown', 'GeneratedAt=x', 'BeeFlowAutomation=']);
});

test('pdfkit fallback: Info dictionary carries Title/Author/Subject/Keywords + custom AIGenerated, footer line present', async () => {
    browser.mode = 'unavailable';
    const out = await renderer.renderDocument({ content: '# Hallo\n\n- punt', title: 'Brief', marking: MARKING });
    assert.strictEqual(out.degraded, true);
    assert.deepStrictEqual(out.marking, { visible: true, metadata: true });
    // pdfkit writes Info values as indirect objects: `/AIGenerated 18 0 R` + `(true)`.
    const raw = out.buffer.toString('latin1');
    assert.match(raw, /\/AIGenerated \d+ 0 R/, 'custom Info key written by pdfkit');
    assert.match(raw, /\/AIProvider \d+ 0 R/);
    assert.match(raw, /\/BeeFlowAutomation \d+ 0 R/);
    assert.ok(raw.includes('(AIGenerated=true; AIProvider=claude; GeneratedAt=2026-09-14T09:00:00.000Z; BeeFlowAutomation=auto-7)'));
    assert.ok(raw.includes('(auto-7)') && raw.includes('(claude)') && raw.includes('(true)'));
    const info = await readPdfInfo(out.buffer);
    assert.strictEqual(info.title, 'Brief');
    assert.strictEqual(info.author, 'Acme BV');
    assert.strictEqual(info.subject, renderer.AI_MARK_SUBJECT);
    assert.strictEqual(info.keywords, KEYWORDS.join('; '));
    assert.strictEqual(info.producer, 'Bee Flow');

    // Unmarked: no AI keys, result.marking null.
    const plain = await renderer.renderDocument({ content: 'x', title: 'Plain' });
    assert.strictEqual(plain.marking, null);
    assert.ok(!plain.buffer.toString('latin1').includes('/AIGenerated'));
});

test('browser PDF: pdf-lib post-processing sets Title/Author/Subject/Keywords/Producer', async () => {
    browser.mode = 'ok';
    const out = await renderer.renderDocument({ content: '# Hallo', title: 'Brief', marking: MARKING });
    assert.strictEqual(out.degraded, false);
    assert.deepStrictEqual(out.marking, { visible: true, metadata: true });
    const info = await readPdfInfo(out.buffer);
    assert.deepStrictEqual(info, {
        title: 'Brief', author: 'Acme BV', subject: 'AI-generated content — EU AI Act Art. 50(2)',
        keywords: KEYWORDS.join(' '), producer: 'Bee Flow',
    });
    // A marking object without a footer text (or enabled:false) is not a marking.
    const off = await renderer.renderDocument({ content: '# Hallo', title: 'Brief', marking: { ...MARKING, enabled: false } });
    assert.strictEqual(off.marking, null);
    assert.ok(!browser.lastHtml.includes('<footer class="ai-mark"'));
    assert.ok(!browser.lastPdfOptions.footerTemplate.includes('flex:1'));
});

test('applyPdfMarkingMetadata keeps the original bytes when the input is not a PDF', async () => {
    const bytes = Buffer.from('not a pdf');
    const r = await renderer._test.applyPdfMarkingMetadata(bytes, MARKING, { title: 'x' });
    assert.strictEqual(r.metadata, false);
    assert.strictEqual(r.buffer, bytes);
    assert.deepStrictEqual(await renderer._test.applyPdfMarkingMetadata(bytes, null), { buffer: bytes, metadata: false });
});

test('docx: core properties from the marking; trailing paragraph in the HTML; unmarked options unchanged', async () => {
    const opts = renderer._test.docxOptions({ title: 'Brief', marking: MARKING });
    assert.deepStrictEqual(opts, {
        table: { row: { cantSplit: true } }, footer: true, pageNumber: true, title: 'Brief',
        subject: renderer.AI_MARK_SUBJECT, creator: 'Acme BV', keywords: KEYWORDS, description: 'Gegenereerd met AI — Acme BV',
    });
    assert.deepStrictEqual(renderer._test.docxOptions({ title: 'Brief' }), { table: { row: { cantSplit: true } }, footer: true, pageNumber: true, title: 'Brief' });

    const out = await renderer.renderDocument({ content: '# Hallo\n\ntekst', title: 'Brief', format: 'docx', marking: MARKING });
    assert.strictEqual(out.format, 'docx');
    assert.deepStrictEqual(out.marking, { visible: true, metadata: true });
    assert.ok(out.buffer.length > 0);
    assert.strictEqual(out.buffer.subarray(0, 2).toString('latin1'), 'PK', 'a zip');
    let JSZip = null;
    try { JSZip = require('jszip'); } catch { /* not hoisted — skip the deep check */ }
    if (JSZip) {
        const zip = await JSZip.loadAsync(out.buffer);
        const core = await zip.file('docProps/core.xml').async('string');
        assert.ok(core.includes('AIGenerated=true'), 'keywords in core.xml');
        assert.ok(core.includes('Acme BV'), 'creator in core.xml');
        const body = await zip.file('word/document.xml').async('string');
        assert.ok(body.includes('Gegenereerd met AI'), 'visible line in the document body');
    }
});
