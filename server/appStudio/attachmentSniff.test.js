/**
 * Type detection for a generic or wrong declared mime: extension proposes,
 * bytes decide.
 * Run: cd server && node --test appStudio/attachmentSniff.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sniffMime, proposeMimeFromName, isGenericMime, DOCX, XLSX } = require('./attachmentSniff.mts');

const OCTET = 'application/octet-stream';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32)]);

test('octet-stream bytes that start with %PDF- are a pdf', () => {
    assert.strictEqual(sniffMime(PDF, { name: 'Order_PO-2026-0001.pdf', mime: OCTET }), 'application/pdf');
    assert.strictEqual(sniffMime(PDF, { name: 'no-extension', mime: '' }), 'application/pdf');
});

test('a ".pdf" whose bytes are not a pdf is not a pdf', () => {
    const html = Buffer.from('<html><body>not a pdf</body></html>');
    assert.notStrictEqual(sniffMime(html, { name: 'order.pdf', mime: OCTET }), 'application/pdf');
    assert.strictEqual(sniffMime(html, { name: 'order.pdf', mime: OCTET }), OCTET);
    // and a declared pdf that is really a png is an image
    assert.strictEqual(sniffMime(PNG, { name: 'order.pdf', mime: 'application/pdf' }), 'image/png');
});

test('image signatures give the image type', () => {
    assert.strictEqual(sniffMime(PNG, { name: 'a.bin', mime: OCTET }), 'image/png');
    assert.strictEqual(sniffMime(JPEG, { name: 'a.bin', mime: OCTET }), 'image/jpeg');
    assert.strictEqual(sniffMime(GIF, { name: 'a.bin', mime: OCTET }), 'image/gif');
});

test('a zip with an office extension is that office type, any other zip is a zip', () => {
    assert.strictEqual(sniffMime(ZIP, { name: 'po.docx', mime: OCTET }), DOCX);
    assert.strictEqual(sniffMime(ZIP, { name: 'po.XLSX', mime: OCTET }), XLSX);
    assert.strictEqual(sniffMime(ZIP, { name: 'bundle.zip', mime: OCTET }), 'application/zip');
    assert.strictEqual(sniffMime(ZIP, { name: 'po.pdf', mime: OCTET }), 'application/zip');
    assert.strictEqual(sniffMime(OLE, { name: 'old.doc', mime: OCTET }), 'application/msword');
});

test('CAD extensions propose their canonical mime (the CAD sniff confirms elsewhere)', () => {
    assert.strictEqual(proposeMimeFromName('part.step', OCTET), 'model/step');
    assert.strictEqual(proposeMimeFromName('part.STP', ''), 'model/step');
    assert.strictEqual(proposeMimeFromName('drawing.dxf', OCTET), 'image/vnd.dxf');
    assert.strictEqual(sniffMime(Buffer.from('ISO-10303-21;\n'), { name: 'part.step', mime: OCTET }), 'model/step');
});

test('a declared non-generic mime with no contradicting bytes is kept; generic mimes are recognised', () => {
    assert.strictEqual(sniffMime(Buffer.from('a,b\n1,2\n'), { name: 'x.csv', mime: 'text/csv; charset=utf-8' }), 'text/csv');
    assert.strictEqual(sniffMime(Buffer.from('a,b\n1,2\n'), { name: 'x.csv', mime: OCTET }), 'text/csv');
    assert.ok(isGenericMime(''));
    assert.ok(isGenericMime(undefined));
    assert.ok(!isGenericMime('application/pdf'));
});

test('an executable renamed .pdf stays octet-stream', () => {
    assert.strictEqual(sniffMime(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 1)]), { name: 'x.pdf', mime: OCTET }), OCTET);
});
