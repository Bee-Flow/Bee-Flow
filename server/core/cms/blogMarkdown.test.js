// @typecheck strict
/**
 * The blog body renderer is the one place stored Markdown becomes public HTML,
 * so these are stored-XSS tests first: raw HTML, unsafe URL schemes and
 * obfuscated schemes must never come out as markup or links.
 *
 * Run: node --test core/cms/blogMarkdown.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    renderPostMarkdown, safeUrl, markdownToPlainText, readingMinutes, deriveExcerpt,
    extractAssetKeys, sanitizeMediaRef,
} = require('./blogMarkdown');

test('raw HTML is shown as text, never rendered', () => {
    const html = renderPostMarkdown('Hi <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil"></iframe>');
    assert.ok(!/<script|<img|<iframe|onerror=/i.test(html.replace(/&lt;[^]*?&gt;/g, '')), html);
    assert.match(html, /&lt;script&gt;/);
});

test('unsafe link and image schemes are dropped, including obfuscated ones', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'vbscript:x', 'data:text/html,<b>x</b>', '//evil.example/x', 'file:///etc/passwd']) {
        const html = renderPostMarkdown(`[click](${href}) ![img](${href})`);
        assert.ok(!/href=|src=/i.test(html), `${href} → ${html}`);
    }
});

test('safe links survive; external ones get rel, own-origin ones do not', () => {
    const html = renderPostMarkdown('[a](https://example.com) [b](/pricing) [c](#setup) [d](mailto:hi@example.com)', { origin: 'https://site.test' });
    assert.match(html, /<a href="https:\/\/example.com" rel="noopener noreferrer nofollow">a<\/a>/);
    assert.match(html, /<a href="https:\/\/site.test\/pricing">b<\/a>/);
    assert.match(html, /<a href="#setup">c<\/a>/);
    assert.match(html, /href="mailto:hi@example.com"/);
});

test('CMS asset keys become asset URLs; headings shift down and get ids', () => {
    const html = renderPostMarkdown('# Setup guide\n\n![chart](cms/1700-chart.png)');
    assert.match(html, /<h2 id="setup-guide">Setup guide<\/h2>/);
    assert.match(html, /<img src="\/api\/cms\/asset\/cms\/1700-chart.png" alt="chart" loading="lazy" decoding="async">/);
    assert.ok(!/<h1/.test(html), 'the post title is the only h1');
});

test('safeUrl: images never take mailto or anchors', () => {
    assert.strictEqual(safeUrl('mailto:x@y.z', { kind: 'image' }), '');
    assert.strictEqual(safeUrl('#a', { kind: 'image' }), '');
    assert.strictEqual(safeUrl('cms/../secret', {}), '');
    assert.strictEqual(safeUrl('pricing'), '/pricing');
});

test('sanitizeMediaRef accepts asset keys and https only', () => {
    assert.strictEqual(sanitizeMediaRef('cms/a.png'), 'cms/a.png');
    assert.strictEqual(sanitizeMediaRef('/api/cms/asset/cms/a.png'), '/api/cms/asset/cms/a.png');
    assert.strictEqual(sanitizeMediaRef('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
    for (const bad of ['http://x.example/a.png', 'javascript:alert(1)', 'cms/../x', 'https://x.example/a.png" onerror="x', '/etc/passwd']) {
        assert.strictEqual(sanitizeMediaRef(bad), '', bad);
    }
});

test('plain text, excerpt, reading time and asset extraction', () => {
    const md = '## Title\n\nSome **bold** text with a [link](https://x.y).\n\n```js\ncode()\n```';
    assert.strictEqual(markdownToPlainText(md), 'Title Some bold text with a link.');
    assert.strictEqual(readingMinutes(''), 0);
    assert.strictEqual(readingMinutes(Array(440).fill('word').join(' ')), 2);
    assert.ok(deriveExcerpt(Array(100).fill('word').join(' '), 40).endsWith('…'));
    assert.deepStrictEqual(extractAssetKeys('![a](cms/x.png) [b](/api/cms/asset/cms/y%20z.png) cms/../bad'), ['cms/x.png', 'cms/y z.png']);
});
