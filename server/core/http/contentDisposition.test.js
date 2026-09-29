/**
 * Download names (core/http/contentDisposition.js). A template's file name is
 * whatever the uploader's multipart header said, so it can carry `../` or
 * quotes; the filled copy used to be written to path.join(dir, name) and sent
 * as filename="${name}" unescaped.
 *
 * Run: cd server && node --test core/http/contentDisposition.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { contentDisposition, safeFileName } = require('./contentDisposition');

test('safeFileName keeps an ordinary name', () => {
    assert.strictEqual(safeFileName('offer_filled.docx'), 'offer_filled.docx');
});

test('safeFileName cannot climb out of a directory', () => {
    for (const hostile of ['../../../etc/passwd', '..\\..\\win.ini', '/abs/path.docx', '..', '.hidden', 'a/../../b.docx']) {
        const name = safeFileName(hostile);
        const dir = '/data/templates_filled/u1';
        const resolved = path.resolve(dir, `123_${name}`);
        assert.ok(resolved.startsWith(dir + path.sep), `${hostile} -> ${name} -> ${resolved}`);
        assert.doesNotMatch(name, /[\\/]/);
        assert.doesNotMatch(name, /^\./);
    }
});

test('safeFileName replaces what a filesystem or header could misread', () => {
    assert.strictEqual(safeFileName('Offerte "Q3" café.docx'), 'Offerte__Q3__caf_.docx');
    assert.strictEqual(safeFileName(''), 'document');
});

test('contentDisposition quotes safely and carries the real name', () => {
    const h = contentDisposition('Offerte "Q3"\r\nX-Evil: 1 café.docx');
    assert.doesNotMatch(h, /[\r\n]/);
    assert.match(h, /^attachment; filename="Offerte _Q3___X-Evil: 1 caf_\.docx"; filename\*=UTF-8''/);
    assert.match(h, /caf%C3%A9\.docx$/);
});
