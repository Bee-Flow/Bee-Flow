const { test } = require('node:test');
const assert = require('node:assert');

const { stripTags, convertAllHtmlTablesToMarkdown } = require('./markdownCleanup');

test('stripTags decodes each entity once: "&amp;lt;" is the text "&lt;", not "<"', () => {
    assert.strictEqual(stripTags('use &amp;lt;b&amp;gt; for bold'), 'use &lt;b&gt; for bold');
    assert.strictEqual(stripTags('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a & b <c> "d"');
});

test('a table cell holding an escaped entity survives the markdown conversion', () => {
    const md = convertAllHtmlTablesToMarkdown('<table><tr><th>k</th><th>v</th></tr><tr><td>esc</td><td>&amp;nbsp;</td></tr></table>');
    assert.ok(md.includes('| esc | &nbsp; |'), md);
});
