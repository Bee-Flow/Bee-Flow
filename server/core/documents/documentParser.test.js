/**
 * parseDocument's PDF fallback (core/documents/documentParser.js) — the path a
 * PDF takes when Mistral OCR is not configured.
 *
 * It used pdf-parse 1's calling convention on pdf-parse 2: `new PDFParse()`
 * without the data, a `load()` that does not exist, and `getText()`'s result
 * object treated as a string. Every PDF came back as
 * "[PDF: x — failed to parse …]". The server typecheck found it.
 *
 * Run: cd server && node --test core/documents/documentParser.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { newDoc, collect } = require('../../utils/pdfKit');
const { parseDocument } = require('./documentParser');

async function pdfWith(text) {
    const doc = newDoc();
    const done = collect(doc);
    doc.fontSize(12).text(text);
    doc.end();
    return done;
}

test('a text PDF comes back as its text, not as a parse failure', async () => {
    const buffer = await pdfWith('Quarterly report for the tulip growers');
    const out = await parseDocument(buffer, 'application/pdf', 'report.pdf');
    assert.doesNotMatch(out, /failed to parse/);
    assert.match(out, /Quarterly report for the tulip growers/);
});

test('a PDF with no text layer says so instead of returning an empty string', async () => {
    const doc = newDoc();
    const done = collect(doc);
    doc.rect(10, 10, 50, 50).fill('#000');
    doc.end();
    const out = await parseDocument(await done, 'application/pdf', 'scan.pdf');
    assert.match(out, /no extractable text/);
});

test('bytes that are not a PDF report a parse failure with the file name', async () => {
    const out = await parseDocument(Buffer.from('not a pdf at all'), 'application/pdf', 'broken.pdf');
    assert.match(out, /^\[PDF: broken\.pdf — failed to parse/);
});

test('pages are joined without the library\'s page markers', async () => {
    const doc = newDoc();
    const done = collect(doc);
    doc.text('first page');
    doc.addPage();
    doc.text('second page');
    doc.end();
    const out = await parseDocument(await done, 'application/pdf', 'two.pdf');
    assert.strictEqual(out, 'first page\n\nsecond page');
});
