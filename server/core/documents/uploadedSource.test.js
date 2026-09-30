'use strict';

/**
 * The shared block behind POST /api/notebooks/:id/sources/file and
 * POST /api/webpages/:id/sources/file.
 *
 * Run: cd server && node --test core/documents/uploadedSource.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { keepUploadedSource, sourceTypeOf } = require('./uploadedSource');

test('the extension names the source type, anything else is a plain file', () => {
    assert.strictEqual(sourceTypeOf('Report.PDF'), 'pdf');
    assert.strictEqual(sourceTypeOf('old.doc'), 'docx');
    assert.strictEqual(sourceTypeOf('sheet.xls'), 'xlsx');
    assert.strictEqual(sourceTypeOf('notes.md'), 'text');
    assert.strictEqual(sourceTypeOf('data.csv'), 'csv');
    assert.strictEqual(sourceTypeOf('photo.png'), 'file');
    assert.strictEqual(sourceTypeOf('noextension'), 'file');
    assert.strictEqual(sourceTypeOf('evil.constructor'), 'file', 'an inherited property is not a source type');
    assert.strictEqual(sourceTypeOf(''), 'file');
});

function fakeStorage(available) {
    const uploads = [];
    return {
        uploads,
        isAvailable: () => available,
        buildKey: (userId, folder, name) => `${userId}/${folder}/${name}`,
        uploadFile: async (key, buffer, mimeType) => { uploads.push({ key, buffer, mimeType }); },
    };
}

const FILE = { originalname: 'Q3 plan (final).pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF') };

test('with storage, the file is kept under a sanitised, prefixed name in the caller\'s folder', async () => {
    const storage = fakeStorage(true);
    const out = await keepUploadedSource(FILE, { userId: 'u1', prefix: 'nb', folder: 'notebooks', storage });
    assert.strictEqual(out.fileName, FILE.originalname);
    assert.strictEqual(out.mimeType, 'application/pdf');
    assert.strictEqual(out.buffer, FILE.buffer);
    assert.strictEqual(out.type, 'pdf');
    assert.match(out.storageKey, /^u1\/notebooks\/nb_\d+_[0-9a-f]{8}_Q3_plan__final_\.pdf$/);
    assert.deepStrictEqual(storage.uploads, [{ key: out.storageKey, buffer: FILE.buffer, mimeType: 'application/pdf' }]);
});

test('without storage nothing is uploaded and the key is null', async () => {
    const storage = fakeStorage(false);
    const out = await keepUploadedSource(FILE, { userId: 'u1', prefix: 'wp', folder: 'webpage-sources', storage });
    assert.strictEqual(out.storageKey, null);
    assert.strictEqual(out.type, 'pdf');
    assert.deepStrictEqual(storage.uploads, []);
});
