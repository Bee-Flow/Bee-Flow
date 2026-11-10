const test = require('node:test');
const assert = require('node:assert/strict');
const { htmlToPlainish } = require('./documentPdf');

test('htmlToPlainish decodes each entity once: "&amp;lt;" stays the text "&lt;"', () => {
    assert.equal(htmlToPlainish('<p>write &amp;lt;b&amp;gt; for bold, a &lt; b &amp; c</p>').trim(), 'write &lt;b&gt; for bold, a < b & c');
});
