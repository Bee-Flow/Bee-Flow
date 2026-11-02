/**
 * The house-style extractor (core/text/houseStyleExtractor.js) reads an
 * uploaded .docx for its styles: a package that declares more than a document
 * holds, or a part that inflates past its cap, leaves the defaults instead of
 * costing the inflated size.
 *
 * Run: cd server && node --test core/text/houseStyleExtractor.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { extract, DEFAULTS } = require('./houseStyleExtractor');

const STYLES = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia"/><w:sz w:val="26"/></w:rPr></w:rPrDefault></w:docDefaults>
</w:styles>`;

async function docx(extra = {}) {
    const zip = new JSZip();
    zip.file('word/styles.xml', STYLES);
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
    for (const [name, content] of Object.entries(extra)) zip.file(name, content);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('a normal document yields its body font', async () => {
    const meta = await extract(await docx());
    assert.strictEqual(meta.defaultFont, 'Georgia');
    assert.strictEqual(meta.defaultFontSize, 13);
});

test('a document that declares more than a document holds leaves the defaults, quickly', async () => {
    const buf = await docx({ 'word/media/bomb.bin': Buffer.alloc(300 * 1024 * 1024) });
    const t0 = Date.now();
    const meta = await extract(buf);
    assert.ok(Date.now() - t0 < 1000, `answered in ${Date.now() - t0} ms`);
    assert.deepStrictEqual(meta, JSON.parse(JSON.stringify(DEFAULTS)));
});
