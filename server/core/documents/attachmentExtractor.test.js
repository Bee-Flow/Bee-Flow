/**
 * Unit tests for the content-type routing in the unified attachment
 * extractor. Pure logic for the detectors + the dependency-free plain-text
 * and CAD branches — the real PDF/Office/image extractors need external
 * services and are exercised elsewhere / manually. The PDF pipeline's
 * documentMode routing IS tested here, against require-cache stubs.
 *
 * Run: node core/attachmentExtractor.test.js   (or: node --test)
 */

const assert = require('assert');

// ── require-cache stubs (installed BEFORE the module under test) ─────
// The PDF branch normally needs pdfjs + OCR providers; stub what the ladder
// calls so documentMode routing is testable without any of them.
function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const pdfStub = { text: '', numPages: 1, renderCalls: 0 };
stub('./pdfExtractor', {
    extractTextFromPDFWithStats: async () => ({
        text: pdfStub.text,
        numPages: pdfStub.numPages,
        pageCharCounts: [pdfStub.text.length],
        pages: [],
    }),
});
stub('./pdfToImages', {
    renderPdfPagesToImages: async () => {
        pdfStub.renderCalls += 1;
        return { images: [{ base64: 'iVBORw0KG', mimeType: 'image/png' }], totalPages: 1, truncated: false };
    },
});
stub('../../stores/configStore', { getConfig: async () => null });   // Azure DI off
const ocrStub = { text: null, calls: 0 };
stub('./ocr', { mistralOCR: async () => { ocrStub.calls += 1; return ocrStub.text; } });

const {
    extractAttachment,
    isPdf,
    isDocx,
    isPptx,
    isSpreadsheet,
    isImage,
    isCad,
    isPlainText,
} = require('./attachmentExtractor');

(async () => {
    // ── type detectors ─────────────────────────────────────────────────
    assert.ok(isPdf({ type: 'application/pdf', name: 'a.pdf' }));
    assert.ok(isDocx({ type: '', name: 'a.docx' }));
    assert.ok(isPptx({ type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', name: 'x' }), 'pptx by mime');
    assert.ok(isPptx({ type: '', name: 'deck.PPTX' }), 'pptx by extension, case-insensitive');
    assert.ok(!isDocx({ type: '', name: 'deck.pptx' }) && !isSpreadsheet({ type: '', name: 'deck.pptx' }), 'a deck is neither a doc nor a sheet');
    assert.ok(isSpreadsheet({ type: 'text/csv', name: 'a.csv' }), 'csv routes to the spreadsheet branch');
    assert.ok(isSpreadsheet({ type: '', name: 'a.xlsx' }));

    assert.ok(isImage({ type: 'image/png', name: 'a.png' }), 'image/* by mime');
    assert.ok(isImage({ type: '', name: 'photo.JPG' }), 'image by extension, case-insensitive');
    assert.ok(!isImage({ type: 'application/pdf', name: 'a.pdf' }), 'pdf is not an image');

    assert.ok(isPlainText({ type: 'text/plain', name: 'a.txt' }));
    assert.ok(isPlainText({ type: '', name: 'notes.md' }));
    assert.ok(isPlainText({ type: 'application/json', name: 'data.json' }));
    assert.ok(!isPlainText({ type: 'application/pdf', name: 'a.pdf' }), 'pdf is not plain text');

    // ── plain-text extraction (no external services) ───────────────────
    {
        const content = Buffer.from('hello world', 'utf-8').toString('base64');
        const res = await extractAttachment({ name: 'a.txt', type: 'text/plain', content });
        assert.strictEqual(res.kind, 'text');
        assert.strictEqual(res.text, 'hello world');
        assert.strictEqual(res.source, 'utf8');
    }

    // ── NUL / control chars are stripped (Postgres jsonb can't store NUL) ─
    {
        const raw = 'Invoice \u0000 Q850\u0000OU0P\tline2\nline3';
        const content = Buffer.from(raw, 'utf-8').toString('base64');
        const res = await extractAttachment({ name: 'a.txt', type: 'text/plain', content });
        assert.strictEqual(res.kind, 'text');
        assert.ok(!res.text.includes('\u0000'), 'NUL bytes stripped from extracted text');
        assert.ok(res.text.includes('\t') && res.text.includes('\n'), 'tab/newline preserved');
        assert.strictEqual(res.text, 'Invoice  Q850OU0P\tline2\nline3');
    }

    // ── data-URL prefixed content is decoded ───────────────────────────
    {
        const b64 = Buffer.from('inline', 'utf-8').toString('base64');
        const res = await extractAttachment({ name: 'b.md', type: 'text/markdown', content: `data:text/markdown;base64,${b64}` });
        assert.strictEqual(res.kind, 'text');
        assert.strictEqual(res.text, 'inline');
    }

    // ── unknown binary type → failed (caller surfaces a clear message) ──
    {
        const content = Buffer.from('\x00\x01\x02', 'binary').toString('base64');
        const res = await extractAttachment({ name: 'x.bin', type: 'application/octet-stream', content });
        assert.strictEqual(res.kind, 'failed');
    }

    // ── missing content → failed ───────────────────────────────────────
    {
        const res = await extractAttachment({ name: 'x.txt', type: 'text/plain', content: '' });
        assert.strictEqual(res.kind, 'failed');
    }

    // ── CAD detector ───────────────────────────────────────────────────
    assert.ok(isCad({ type: 'text/plain', name: 'plate.dxf' }), 'extension wins over a text/plain label');
    assert.ok(isCad({ type: 'application/octet-stream', name: 'part.step' }));
    assert.ok(isCad({ type: 'image/vnd.dwg', name: 'download' }), 'canonical mime without extension');
    assert.ok(isCad({ type: 'application/dxf', name: 'x' }), 'vendor alias mime');
    assert.ok(!isCad({ type: 'text/plain', name: 'a.txt' }));
    assert.ok(!isCad({ type: 'application/pdf', name: 'a.pdf' }));

    // ── the LIVE-bug regression: a text/plain DXF routes to CAD ────────
    // Before the isCad branch, this matched isPlainText and dumped the whole
    // raw CAD body into the prompt.
    {
        const dxf = [
            '  0', 'SECTION', '  2', 'HEADER',
            '  9', '$ACADVER', '  1', 'AC1027',
            '  0', 'ENDSEC',
            '  0', 'SECTION', '  2', 'ENTITIES',
            '  0', 'CIRCLE', ' 10', '1.0', ' 20', '1.0', ' 40', '0.5',
            '  0', 'ENDSEC', '  0', 'EOF',
        ].join('\r\n');
        const res = await extractAttachment({ name: 'plate.dxf', type: 'text/plain', content: Buffer.from(dxf).toString('base64') });
        assert.strictEqual(res.kind, 'text');
        assert.strictEqual(res.source, 'cad', 'routed to the CAD header reader, not the raw plain-text branch');
        assert.strictEqual(res.meta.format, 'dxf');
        assert.ok(!res.text.includes('$ACADVER'), 'the raw CAD body is not dumped into the prompt');
    }

    // ── documentMode 'images': forced rasterisation WITH the text layer ─
    // A vector technical drawing has a DENSE text layer, so 'auto' would stop
    // at pdfjs and the model would never see the geometry.
    const densePdf = { name: 'drawing.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.7 fake').toString('base64') };
    {
        pdfStub.text = 'DIM 254 mm '.repeat(60);
        pdfStub.renderCalls = 0;
        const res = await extractAttachment(densePdf, { modelSupportsVision: true, documentMode: 'images' });
        assert.strictEqual(res.kind, 'images');
        assert.strictEqual(res.source, 'vision-forced');
        assert.strictEqual(pdfStub.renderCalls, 1, 'rendered despite the dense text layer');
        assert.ok(res.images.length >= 1);
        assert.ok(res.text && res.text.includes('DIM 254'), 'the pdfjs text rides along with the images');
    }

    // 'images' without a vision model falls back to the normal text path
    {
        pdfStub.text = 'DIM 254 mm '.repeat(60);
        pdfStub.renderCalls = 0;
        const res = await extractAttachment(densePdf, { modelSupportsVision: false, documentMode: 'images' });
        assert.strictEqual(res.kind, 'text');
        assert.strictEqual(res.source, 'pdfjs');
        assert.strictEqual(pdfStub.renderCalls, 0, 'no rendering without vision');
    }

    // 'text' NEVER rasterises — even with an empty text layer + a vision model
    {
        pdfStub.text = '';
        pdfStub.renderCalls = 0;
        const res = await extractAttachment(densePdf, { modelSupportsVision: true, documentMode: 'text' });
        assert.strictEqual(res.kind, 'failed', 'no OCR configured and rasterising is forbidden');
        assert.strictEqual(pdfStub.renderCalls, 0, "documentMode 'text' never rasterises");
    }

    // default 'auto' keeps today's ladder: insufficient text + vision → images
    {
        pdfStub.text = '';
        pdfStub.renderCalls = 0;
        const res = await extractAttachment(densePdf, { modelSupportsVision: true });
        assert.strictEqual(res.kind, 'images');
        assert.strictEqual(res.source, 'vision-fallback');
        assert.strictEqual(pdfStub.renderCalls, 1);
    }

    // ── the image branch: a picture must survive the trip ──────────────
    // Regression. A photo used to be replaced by whatever OCR could make of
    // it, even for a caller that could see: a meter cupboard arrived at the
    // model as `# 1` and it answered, reasonably, that it saw the digit 1 on
    // an empty background.
    const photo = { name: 'meterkast.png', type: 'image/png', content: 'iVBORw0KGgo=' };

    {
        ocrStub.text = '# 1';
        ocrStub.calls = 0;
        const res = await extractAttachment(photo, { modelSupportsVision: true, documentMode: 'images' });
        assert.strictEqual(res.kind, 'images', 'a vision caller gets the picture');
        assert.strictEqual(res.images[0].base64, 'iVBORw0KGgo=', 'the original bytes, not a re-encode');
        assert.strictEqual(res.images[0].mimeType, 'image/png');
        assert.strictEqual(ocrStub.calls, 0, "documentMode 'images' does not wait on OCR");
    }

    {
        ocrStub.text = 'FACTUUR 2026-114';
        ocrStub.calls = 0;
        const res = await extractAttachment(photo, { modelSupportsVision: true });
        assert.strictEqual(res.kind, 'images', "'auto' + vision still hands over the picture");
        assert.strictEqual(res.images.length, 1);
        assert.strictEqual(res.text, 'FACTUUR 2026-114', 'OCR rides alongside, never instead');
        assert.strictEqual(ocrStub.calls, 1);
    }

    {
        // The header must not announce "0 pages rendered" over a picture.
        const { formatImagesHeader } = require('./attachmentExtractor');
        ocrStub.text = null;
        ocrStub.calls = 0;
        const res = await extractAttachment(photo, { modelSupportsVision: true });
        const header = formatImagesHeader(photo, res);
        assert.ok(!header.includes('0 page'), `no page count for a photo: ${header}`);
        assert.ok(header.includes('the image itself follows'), header);
    }

    // A caller that cannot see, or asked for text only, is untouched — this is
    // every connector (Gmail, Drive, Nextcloud), which passes no vision flag.
    {
        ocrStub.text = 'FACTUUR 2026-114';
        const res = await extractAttachment(photo, {});
        assert.strictEqual(res.kind, 'text');
        assert.strictEqual(res.text, 'FACTUUR 2026-114');
        assert.strictEqual(res.source, 'mistral');
    }
    {
        ocrStub.text = 'FACTUUR 2026-114';
        const res = await extractAttachment(photo, { modelSupportsVision: true, documentMode: 'text' });
        assert.strictEqual(res.kind, 'text', "'text' never hands over pixels");
    }
    {
        ocrStub.text = null;
        const res = await extractAttachment(photo, {});
        assert.strictEqual(res.kind, 'failed', 'no vision and no OCR is still an honest failure');
    }

    // ── the CAD render path, end to end ────────────────────────────────
    // THE REGRESSION THIS EXISTS FOR: the renderers were required INSIDE the
    // branch's own try/catch, so a moved file turned into MODULE_NOT_FOUND and
    // the catch logged it as "could not render this file". Every STEP a model
    // was asked to look at came back as a header line for weeks, and the app
    // dutifully wrote "het 3D-model bevat alleen de header" onto real order
    // lines. Only a test that runs the RENDER — not the routing — catches that,
    // so this one draws an actual sheet.
    {
        const dxf = [
            '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
            '0', 'SECTION', '2', 'ENTITIES',
            '0', 'LWPOLYLINE', '90', '4', '70', '1',
            '10', '0', '20', '0', '10', '80', '20', '0', '10', '80', '20', '40', '10', '0', '20', '40',
            '0', 'CIRCLE', '10', '40', '20', '20', '40', '5',
            '0', 'ENDSEC', '0', 'EOF',
        ].join('\r\n') + '\r\n';
        const att = {
            name: '19.0592.136.01_alu_5mm.DXF',
            type: 'image/vnd.dxf',
            content: Buffer.from(dxf, 'utf8').toString('base64'),
        };

        const res = await extractAttachment(att, { modelSupportsVision: true });
        assert.strictEqual(res.kind, 'images', 'a mailed cut file reaches the model as a picture');
        assert.strictEqual(res.images.length, 1);
        assert.ok(res.images[0].base64.length > 500, 'a real PNG, not a stub');
        assert.ok(/80 x 40 mm/.test(res.text), `the sheet size travels with it: ${res.text}`);
        assert.ok(res.meta.rendered, 'meta says a picture was drawn');
        // The header text is not dropped for the picture — it is the exact half.
        assert.ok(/DXF/i.test(res.text), `the header rides along: ${res.text}`);

        const textOnly = await extractAttachment(att, { modelSupportsVision: true, documentMode: 'text' });
        assert.strictEqual(textOnly.kind, 'text', "'text' never rasterises a drawing either");
    }

    // The 3D renderer needs a WASM kernel and a real solid, so it is not driven
    // here — but its MODULE must resolve, which is the half that broke.
    {
        const { renderCadSheet } = require('../cad/cadRender');
        assert.strictEqual(typeof renderCadSheet, 'function', 'the STEP/IGES renderer is reachable from here');
    }

    // A format no kernel here opens keeps the honest header-only answer.
    {
        const dwg = { name: 'plate.dwg', type: 'image/vnd.dwg', content: Buffer.from('AC1032 not really a dwg').toString('base64') };
        const res = await extractAttachment(dwg, { modelSupportsVision: true });
        assert.strictEqual(res.kind, 'text', 'DWG stays text — nothing here can draw it');
    }

    // ── PPTX routes through the office pipeline and keeps slide boundaries ──
    {
        const { normalizeDeck } = require('./deckModel');
        const officegen = require('../../integrations/officegen');
        const deck = normalizeDeck({ title: 'Deck', slides: [{ title: 'Alpha', bullets: ['one'], notes: 'say this' }, { title: 'Beta', bullets: ['two'] }] });
        const { buffer } = await officegen.buildPresentation({ deck });
        const att = { name: 'deck.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', content: buffer.toString('base64') };
        const res = await extractAttachment(att, {});
        assert.strictEqual(res.kind, 'text', 'a deck is text for the model');
        assert.strictEqual(res.source, 'documentParser');
        assert.ok(/## Slide 2: Alpha/.test(res.text), `slide sections: ${res.text.slice(0, 120)}`);
        assert.ok(/Speaker notes:\nsay this/.test(res.text), 'notes ride along, labelled');
        assert.ok(res.text.indexOf('Alpha') < res.text.indexOf('Beta'), 'slide order kept');
    }

    console.log('core/attachmentExtractor.test.js — all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
