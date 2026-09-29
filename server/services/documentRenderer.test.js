/**
 * documentRenderer — the bytes a `generate_document` step hands to a visitor.
 *
 * Three things are worth pinning:
 *
 *   1. The output really is the file it claims to be. A PDF starts `%PDF-`; a
 *      .docx is a ZIP whose first entry names word/document.xml. Asserting on
 *      "it returned a buffer" would pass for a buffer of the word "undefined".
 *   2. The PDF survives a stack with no browser. The server image bakes in no
 *      Chromium, so on a self-host without the pwt-runner container the browser
 *      path throws — and the visitor must still get a PDF, flagged `degraded`.
 *   3. Content is inert. It arrives from model output and form answers and is
 *      then loaded into a real browser ON THE SERVER; a <script>, an <iframe>
 *      or a remote <img src> that survives is a server-side request forgery
 *      with extra steps.
 *
 * browserProvider is mocked — these tests must not need a container.
 *
 * Run: node --test services/documentRenderer.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// The fake browser: records the HTML it was given, returns a minimal real PDF.
const browser = { html: null, fail: null, calls: 0 };
mock(path.join(__dirname, 'browserProvider.js'), {
    withContext: async (_opts, fn) => {
        browser.calls += 1;
        if (browser.fail) throw new Error(browser.fail);
        const page = {
            setDefaultTimeout() {},
            async setContent(html) { browser.html = html; },
            async pdf() { return Buffer.from('%PDF-1.7\n% fake\n%%EOF\n'); },
        };
        return fn({ newPage: async () => page });
    },
});

const { renderDocument, _test } = require('./documentRenderer');

const reset = () => { browser.html = null; browser.fail = null; browser.calls = 0; };

const MD = '# Kwartaalrapport\n\nEen **vette** zin met een [link](https://example.test/x).\n\n- eerste\n- tweede\n';

test('a PDF really is a PDF, and comes from the browser when one is there', async () => {
    reset();
    const out = await renderDocument({ content: MD, title: 'Rapport', format: 'pdf' });
    assert.strictEqual(out.format, 'pdf');
    assert.strictEqual(out.contentType, 'application/pdf');
    assert.strictEqual(out.buffer.subarray(0, 5).toString(), '%PDF-');
    assert.strictEqual(out.degraded, false, 'the browser path is not a fallback');
    assert.strictEqual(browser.calls, 1);
});

test('a DOCX really is a Word package', async () => {
    reset();
    const out = await renderDocument({ content: MD, title: 'Rapport', format: 'docx' });
    assert.strictEqual(out.extension, 'docx');
    // ZIP local-file-header magic, then the part name somewhere in the archive.
    assert.strictEqual(out.buffer.subarray(0, 2).toString(), 'PK');
    assert.ok(out.buffer.includes(Buffer.from('word/document.xml')), 'it is an OOXML package');
    assert.strictEqual(browser.calls, 0, 'Word never needs a browser');
});

test('markdown becomes real markup, not literal syntax', async () => {
    reset();
    await renderDocument({ content: MD, title: 'Rapport', format: 'pdf' });
    assert.match(browser.html, /<h1[^>]*>Kwartaalrapport<\/h1>/);
    assert.match(browser.html, /<strong>vette<\/strong>/);
    assert.match(browser.html, /<li>eerste<\/li>/);
    assert.ok(!browser.html.includes('**vette**'), 'no raw markdown reaches the page');
});

test('no browser still yields a PDF, and says it is the plain one', async () => {
    reset();
    browser.fail = 'Browser backend unavailable';
    const out = await renderDocument({ content: MD, title: 'Rapport', format: 'pdf' });
    assert.strictEqual(out.buffer.subarray(0, 5).toString(), '%PDF-');
    assert.strictEqual(out.degraded, true, 'the caller can explain why it looks plain');
});

test('the fallback prints text, not markdown punctuation', async () => {
    // pdfkit lays out strings; '**vette**' would otherwise appear verbatim.
    assert.strictEqual(_test.stripInline('een **vette** zin'), 'een vette zin');
    assert.strictEqual(_test.stripInline('zie [de bron](https://x.test)'), 'zie de bron (https://x.test)');
    assert.strictEqual(_test.stripInline('![logo](https://x.test/a.png)'), 'logo');
});

test('script, iframe and event handlers never reach the page', async () => {
    reset();
    await renderDocument({
        content: '<p onclick="steal()">hoi</p><script>fetch("//evil.test")</script><iframe src="//evil.test"></iframe>',
        contentFormat: 'html',
        format: 'pdf',
    });
    assert.ok(!/<script/i.test(browser.html), 'no script survives');
    assert.ok(!/<iframe/i.test(browser.html), 'no iframe survives');
    assert.ok(!/onclick/i.test(browser.html), 'no inline handler survives');
    assert.match(browser.html, /hoi/, 'the actual text does survive');
});

test('a remote image src is blanked — rendering is not a fetch-for-me service', async () => {
    reset();
    await renderDocument({
        content: '<img src="https://evil.test/pixel.png">',
        contentFormat: 'html',
        format: 'pdf',
    });
    assert.ok(!browser.html.includes('evil.test'), 'the server never goes and gets it');
});

test('a javascript: link is defused', async () => {
    reset();
    await renderDocument({ content: '<a href="javascript:alert(1)">klik</a>', contentFormat: 'html', format: 'pdf' });
    assert.ok(!/javascript:/i.test(browser.html));
});

test('the page itself reaches for nothing on the network', async () => {
    // The wrapper is deliberately not templates/exportTemplate.js's, which
    // pulls mermaid from jsdelivr: a routine producing a document must not make
    // the server fetch a CDN script, and must work on an air-gapped self-host.
    reset();
    await renderDocument({ content: MD, title: 'Rapport', format: 'pdf' });
    const chrome = browser.html.replace(/<main>[\s\S]*<\/main>/, '');
    assert.ok(!/<script/i.test(chrome), 'no script tag in the wrapper');
    assert.ok(!/https?:\/\//i.test(chrome), 'no absolute URL in the wrapper');
    assert.ok(!/<link\b/i.test(chrome), 'no external stylesheet');
});

test('a title becomes a real heading, and an absent one adds no empty chrome', async () => {
    reset();
    await renderDocument({ content: MD, title: 'Kwartaal Q3', author: 'Tom', format: 'pdf' });
    assert.match(browser.html, /class="doc-title">Kwartaal Q3</);
    assert.match(browser.html, /Tom · \d{4}-\d{2}-\d{2}/);

    reset();
    await renderDocument({ content: MD, format: 'pdf' });
    assert.ok(!/<header\b/i.test(browser.html), 'no header element at all');
});

test('a title with markup in it is escaped, not rendered', async () => {
    reset();
    await renderDocument({ content: MD, title: '<img src=x onerror=alert(1)>', format: 'pdf' });
    assert.ok(!/<img/i.test(browser.html), 'the title is text, wherever it came from');
});

test('empty content is a clear refusal, not an empty file', async () => {
    reset();
    await assert.rejects(
        () => renderDocument({ content: '   \n  ', format: 'pdf' }),
        (e) => e.errorClass === 'document_empty',
    );
});

test('absurdly large content is refused before any render is attempted', async () => {
    reset();
    await assert.rejects(
        () => renderDocument({ content: 'x'.repeat(2_000_001), format: 'pdf' }),
        (e) => e.errorClass === 'document_too_large',
    );
    assert.strictEqual(browser.calls, 0, 'nothing was handed to the browser');
});

test('an unknown format falls back to PDF rather than inventing one', async () => {
    reset();
    const out = await renderDocument({ content: MD, format: 'rtf' });
    assert.strictEqual(out.format, 'pdf');
});
