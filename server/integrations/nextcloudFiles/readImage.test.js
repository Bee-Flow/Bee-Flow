/**
 * readImage.mts: one image's bytes for an AI step, typed by the bytes,
 * bounded by the step's budget, refused with a reason otherwise.
 *
 * Run: cd server && node --test integrations/nextcloudFiles/readImage.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { readNextcloudImage, sniffImageMime } = require('./readImage.mts');

const ROOT = 'https://nc.example.test/remote.php/dav/files/alice';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

const ctx = (bytes, status = 200, contentType = 'image/png') => {
    const urls = [];
    return {
        urls,
        c: {
            root: ROOT, authError: 'AUTH',
            ncFetch: async (url) => { urls.push(url); return new Response(bytes, { status, headers: { 'content-type': contentType } }); },
        },
    };
};

test('the type comes from the bytes: PNG, JPEG, GIF, WebP; anything else is null', () => {
    assert.strictEqual(sniffImageMime(PNG), 'image/png');
    assert.strictEqual(sniffImageMime(JPEG), 'image/jpeg');
    assert.strictEqual(sniffImageMime(Buffer.from('GIF89a......')), 'image/gif');
    assert.strictEqual(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    assert.strictEqual(sniffImageMime(Buffer.from('II*\0 a tiff')), null);
});

test('reads the image at its path as the caller', async () => {
    const { c, urls } = ctx(PNG);
    const r = await readNextcloudImage('/Receipts/a.png', c);
    assert.deepStrictEqual(r, { ok: true, buffer: PNG, mimeType: 'image/png' });
    assert.strictEqual(urls[0], `${ROOT}/Receipts/a.png`);
});

test('a declared image type the bytes contradict is refused', async () => {
    const r = await readNextcloudImage('/x.jpg', ctx(Buffer.from('plain text, not a picture'), 200, 'image/jpeg').c);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /not a PNG, JPEG, GIF or WebP/);
});

test('over the byte budget, missing, or unauthorised: a reason, no bytes', async () => {
    assert.match((await readNextcloudImage('/a.png', ctx(PNG).c, { maxBytes: 4 })).reason, /size limit/);
    assert.match((await readNextcloudImage('/a.png', ctx('', 404).c)).reason, /no longer in Nextcloud/);
    assert.strictEqual((await readNextcloudImage('/a.png', ctx('', 401).c)).reason, 'AUTH');
});
