'use strict';

/**
 * The images a person attaches to a builder turn (./inboundImages.js): the shapes accepted and
 * the byte accounting. Pure, so tested here; the route's refusals of over-cap and wrong-mime
 * payloads are in ../appStudioBuilder.test.js.
 *
 * Run: cd server && node --test usecases/ai/appStudioBuilder/inboundImages.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    sanitizeInboundImages, base64ByteLength, IMAGE_MIME_ALLOWLIST, MAX_IMAGES_PER_TURN, MAX_IMAGE_BYTES,
} = require('./inboundImages');

/** A data URL of `bytes` decoded bytes. */
const imageDataUrl = (mime = 'image/png', bytes = 12) => `data:${mime};base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;

test('sanitizeInboundImages normalises the accepted shapes and strips nothing else', () => {
    const png = imageDataUrl('image/png', 9);
    assert.deepStrictEqual(sanitizeInboundImages(undefined), { images: [] });
    assert.deepStrictEqual(sanitizeInboundImages(null), { images: [] });
    assert.deepStrictEqual(sanitizeInboundImages([]), { images: [] });

    // Bare string and { dataUrl } object normalise to the same record.
    const fromString = sanitizeInboundImages([png]).images[0];
    const fromObject = sanitizeInboundImages([{ dataUrl: png }]).images[0];
    assert.deepStrictEqual(fromString, fromObject);
    assert.strictEqual(fromString.mimeType, 'image/png');
    assert.strictEqual(fromString.dataUrl, png);

    // An UPPERCASE header mime is accepted and lowercased.
    const upper = sanitizeInboundImages([png.replace('image/png', 'IMAGE/PNG')]);
    assert.strictEqual(upper.images[0].mimeType, 'image/png');

    // Byte accounting is exact (base64 padding included).
    assert.strictEqual(base64ByteLength('AAAA'), 3);
    assert.strictEqual(base64ByteLength('AAA='), 2);
    assert.strictEqual(base64ByteLength('AA=='), 1);
    for (const mime of IMAGE_MIME_ALLOWLIST) {
        assert.strictEqual(sanitizeInboundImages([imageDataUrl(mime, 6)]).images.length, 1, mime);
    }
    assert.strictEqual(MAX_IMAGES_PER_TURN, 4);
    assert.strictEqual(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
});
