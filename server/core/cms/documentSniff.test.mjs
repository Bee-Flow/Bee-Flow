/**
 * core/cms/documentSniff.mts: a CMS document upload is what its type says, by its bytes.
 * PDF starts with %PDF-; DOCX/XLSX/PPTX are ZIP packages with [Content_Types].xml and the
 * main part of that kind; a macro-enabled package (vbaProject.bin) is refused.
 *
 * Run: cd server && node --test core/cms/documentSniff.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { looksLikeDocument, bufferReader, DOCUMENT_KIND } from './documentSniff.mts';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** A ZIP package with these entry names (each with a little content). */
async function zipOf(names, { compression = 'DEFLATE' } = {}) {
    const zip = new JSZip();
    for (const n of names) zip.file(n, `<x>${n}</x>`);
    return zip.generateAsync({ type: 'nodebuffer', compression });
}

const check = (type, buf) => looksLikeDocument(type, buf.length, bufferReader(buf));

test('a PDF starts with %PDF-', async () => {
    assert.equal(await check('application/pdf', Buffer.from('%PDF-1.7\n%\xE2\xE3\n1 0 obj\n')), true);
    assert.equal(await check('application/pdf', Buffer.from('<html><script>alert(1)</script>')), false);
    assert.equal(await check('application/pdf', Buffer.from('%PD')), false);
    assert.equal(await check('application/pdf', Buffer.alloc(0)), false);
});

test('a Word, Excel and PowerPoint package each needs its own main part', async () => {
    assert.equal(await check(DOCX, await zipOf(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])), true);
    assert.equal(await check(XLSX, await zipOf(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'])), true);
    assert.equal(await check(PPTX, await zipOf(['[Content_Types].xml', 'ppt/presentation.xml'], { compression: 'STORE' })), true);
    // The wrong kind for the declared type.
    assert.equal(await check(DOCX, await zipOf(['[Content_Types].xml', 'xl/workbook.xml'])), false);
});

test('a ZIP that is not an Office package, or one with macros, is refused', async () => {
    assert.equal(await check(DOCX, await zipOf(['word/document.xml'])), false, 'no [Content_Types].xml');
    assert.equal(await check(DOCX, await zipOf(['index.html', 'evil.js'])), false);
    assert.equal(await check(DOCX, await zipOf(['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin'])), false, 'macros');
    assert.equal(await check(XLSX, await zipOf(['[Content_Types].xml', 'xl/workbook.xml', 'xl/VBAPROJECT.BIN'])), false, 'macros, any case');
});

test('anything else under an Office type is refused: a PDF, plain text, a cut-off ZIP', async () => {
    assert.equal(await check(DOCX, Buffer.from('%PDF-1.7')), false);
    assert.equal(await check(DOCX, Buffer.from('just text, long enough to have a tail of twenty-two bytes or more')), false);
    const whole = await zipOf(['[Content_Types].xml', 'word/document.xml']);
    assert.equal(await check(DOCX, whole.subarray(0, whole.length - 10)), false, 'no end-of-central-directory record');
    assert.equal(await check(DOCX, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(30)])), false);
});

test('an unknown type is never a document', async () => {
    assert.equal(await check('text/html', Buffer.from('%PDF-1.7')), false);
    assert.deepEqual(Object.keys(DOCUMENT_KIND).sort(), ['application/pdf', DOCX, PPTX, XLSX].sort());
});
