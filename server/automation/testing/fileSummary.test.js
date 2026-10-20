// @typecheck
'use strict';
/**
 * The file fingerprint run compare uses: synthetic decks and sheets only.
 * Run: cd server && node --test automation/testing/fileSummary.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const JSZip = require('jszip');
const { summarizeFile, readCapped, formatOf } = require('./fileSummary');

const slideXml = (title, ...lines) => `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>`
    + `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`
    + `<p:sp><p:txBody>${lines.map(l => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`
    + `</p:spTree></p:cSld></p:sld>`;

async function deck(slides) {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation/>');
    slides.forEach(([title, ...lines], i) => zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(title, ...lines)));
    return zip.generateAsync({ type: 'nodebuffer' });
}

const fileOf = (name, mime, size = 0) => ({ filename: name, mimeType: mime, size });
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

test('a deck gives one part per slide, in numeric order, with title, length and a short text hash', async () => {
    const slides = [['Overview', 'First point'], ['Details', 'Second point', 'Third']];
    for (let i = 3; i <= 11; i++) slides.push([`Slide ${i}`, 'x']);
    const buffer = await deck(slides);
    const out = await summarizeFile({ file: fileOf('deck.pptx', PPTX, buffer.length), readBytes: async () => buffer }, { fileMaxBytes: 0 });
    assert.strictEqual(out.name, 'deck.pptx');
    assert.strictEqual(out.size, buffer.length);
    assert.strictEqual(out.sha256, crypto.createHash('sha256').update(buffer).digest('hex'));
    assert.strictEqual(out.parts.length, 11);
    assert.deepStrictEqual(out.parts.slice(0, 2).map(p => [p.kind, p.index, p.title]), [['slide', 0, 'Overview'], ['slide', 1, 'Details']]);
    assert.strictEqual(out.parts[10].title, 'Slide 11');
    assert.match(out.parts[0].textHash, /^[0-9a-f]{12}$/);
    assert.strictEqual(out.parts[0].textChars, 'Overview\nFirst point'.length);
    assert.strictEqual(out.unreadable, undefined);
});

test('two decks that differ in one slide differ in that slide\'s hash only', async () => {
    const a = await summarizeFile({ file: fileOf('a.pptx', PPTX), readBytes: async () => deck([['T', 'same'], ['U', 'old']]) }, { fileMaxBytes: 0 });
    const b = await summarizeFile({ file: fileOf('b.pptx', PPTX), readBytes: async () => deck([['T', 'same'], ['U', 'new']]) }, { fileMaxBytes: 0 });
    assert.strictEqual(a.parts[0].textHash, b.parts[0].textHash);
    assert.notStrictEqual(a.parts[1].textHash, b.parts[1].textHash);
    assert.notStrictEqual(a.sha256, b.sha256);
});

test('a csv gives one sheet with rows and columns', async () => {
    const buffer = Buffer.from('id,name,score\n1,a,10\n2,b,20\n');
    const out = await summarizeFile({ file: fileOf('data.csv', 'text/csv'), readBytes: async () => buffer }, { fileMaxBytes: 0 });
    assert.strictEqual(out.parts.length, 1);
    assert.strictEqual(out.parts[0].kind, 'sheet');
    assert.strictEqual(out.parts[0].cols, 3);
    assert.ok(out.parts[0].rows >= 3);
});

test('an xlsx gives its worksheets by name', async () => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Alpha').addRows([['a', 'b'], [1, 2]]);
    wb.addWorksheet('Beta').addRows([['x'], [1], [2], [3]]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const out = await summarizeFile({ file: fileOf('book.xlsx', 'application/octet-stream'), readBytes: async () => buffer }, { fileMaxBytes: 0 });
    assert.deepStrictEqual(out.parts.map(p => p.name), ['Alpha', 'Beta']);
    assert.strictEqual(out.parts[0].cols, 2);
    assert.strictEqual(out.parts[1].rows, 4);
});

test('anything else is metadata plus a hash', async () => {
    const buffer = Buffer.from('plain words');
    const out = await summarizeFile({ file: fileOf('notes.txt', 'text/plain'), readBytes: async () => buffer }, { fileMaxBytes: 0 });
    assert.deepStrictEqual(out, { name: 'notes.txt', mime: 'text/plain', size: 11, sha256: sha(buffer) });
});
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('over the cap: metadata only and tooLarge, without reading when the size is known', async () => {
    let reads = 0;
    const known = await summarizeFile({ file: fileOf('big.pptx', PPTX, 5000), readBytes: async () => { reads++; return Buffer.alloc(1); } }, { fileMaxBytes: 1000 });
    assert.deepStrictEqual(known, { name: 'big.pptx', mime: PPTX, size: 5000, sha256: null, tooLarge: true });
    assert.strictEqual(reads, 0);
    const streamed = await summarizeFile({
        file: fileOf('big.bin', 'application/octet-stream', 0),
        readBytes: (max) => readCapped(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), max),
    }, { fileMaxBytes: 1000 });
    assert.strictEqual(streamed.tooLarge, true);
    assert.strictEqual(streamed.sha256, null);
});

test('readCapped reads everything under the cap and everything when the cap is 0', async () => {
    const small = await readCapped(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 10);
    assert.strictEqual(small.toString(), 'abcd');
    const open = await readCapped(Readable.from([Buffer.alloc(3000)]), 0);
    assert.strictEqual(open.length, 3000);
});

test('an unparseable file, a failed read and a part that is too large never throw', async () => {
    const junk = await summarizeFile({ file: fileOf('broken.pptx', PPTX), readBytes: async () => Buffer.from('not a zip') }, { fileMaxBytes: 0 });
    assert.strictEqual(junk.unreadable, true);
    assert.strictEqual(junk.sha256, sha(Buffer.from('not a zip')));
    assert.strictEqual(junk.parts, undefined);

    const failed = await summarizeFile({ file: fileOf('gone.pdf', 'application/pdf'), readBytes: async () => { throw new Error('NoSuchKey'); } }, { fileMaxBytes: 0 });
    assert.deepStrictEqual(failed, { name: 'gone.pdf', mime: 'application/pdf', size: 0, sha256: null, unreadable: true });

    const badCsv = await summarizeFile({ file: fileOf('x.xlsx', 'application/octet-stream'), readBytes: async () => Buffer.from('not a workbook') }, { fileMaxBytes: 0 });
    assert.strictEqual(badCsv.unreadable, true);

    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', 'x'.repeat(30 * 1024 * 1024));
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    assert.ok(bomb.length < 1024 * 1024);
    const refused = await summarizeFile({ file: fileOf('bomb.pptx', PPTX), readBytes: async () => bomb }, { fileMaxBytes: 0 });
    assert.strictEqual(refused.unreadable, true);
});

test('a part that declares a small size but inflates past the cap is stopped while inflating', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '0'.repeat(30 * 1024 * 1024));
    const real = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    // Lie in the central directory: the entry now claims to be 100 bytes when unpacked.
    const lying = Buffer.from(real);
    const central = lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(central > 0);
    assert.ok(lying.readUInt32LE(central + 24) > 20 * 1024 * 1024, 'the field holds the real size before the patch');
    lying.writeUInt32LE(100, central + 24);

    const reader = await JSZip.loadAsync(lying);
    assert.strictEqual(/** @type {any} */ (reader.file('ppt/slides/slide1.xml'))._data.uncompressedSize, 100);

    const refused = await summarizeFile({ file: fileOf('liar.pptx', PPTX), readBytes: async () => lying }, { fileMaxBytes: 0 });
    assert.strictEqual(refused.unreadable, true);
    assert.strictEqual(refused.parts, undefined);
});

test('formatOf reads the extension first, then the media type', () => {
    assert.strictEqual(formatOf('a.PPTX', 'x'), 'pptx');
    assert.strictEqual(formatOf('a', 'text/csv'), 'csv');
    assert.strictEqual(formatOf('a.bin', 'application/octet-stream'), null);
});
