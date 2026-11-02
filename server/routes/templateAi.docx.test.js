/**
 * extractDocxText: the .docx package is checked against the office caps
 * before mammoth inflates it (template upload, template chat attachments).
 *
 * Run: cd server && node --test routes/templateAi.docx.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { extractDocxText } = require('./templateAi');

const MIB = 1024 * 1024;

/** @param {string} bodyXml @param {Record<string, Buffer>} [extra] */
async function docx(bodyXml, extra = {}) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + bodyXml + '</w:body></w:document>');
    for (const [name, content] of Object.entries(extra)) zip.file(name, content);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

test('a normal .docx yields its text', async () => {
    const text = await extractDocxText(await docx('<w:p><w:r><w:t>Dear {{Name}}</w:t></w:r></w:p>'));
    assert.match(text, /Dear \{\{Name\}\}/);
});

test('a .docx whose parts inflate past the cap is a 422 before mammoth runs', async (t) => {
    t.after(() => { delete process.env.OFFICE_PACKAGE_MAX_INFLATED_BYTES; });
    process.env.OFFICE_PACKAGE_MAX_INFLATED_BYTES = String(8 * MIB);
    const buf = await docx('<w:p/>', { 'word/media/filler.bin': Buffer.alloc(32 * MIB) });
    assert.ok(buf.length < MIB);
    await assert.rejects(extractDocxText(buf), (err) => err.status === 422 && err.code === 'document_rejected');
});

test('a file that is no zip is left to mammoth, which refuses it as before', async () => {
    await assert.rejects(extractDocxText(Buffer.from('plain text, not a package')), (err) => !err.status);
});
