// @typecheck
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { pickFormat, renderVariant, resize } = require('./assetVariants');

/** A synthetic noisy JPEG, wide enough to be resized. */
async function sample(width = 1400) {
    const raw = Buffer.alloc(width * 100 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) % 251;
    return sharp(raw, { raw: { width, height: 100, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

const isAvif = (/** @type {Buffer} */ b) => b.subarray(4, 12).toString('latin1').includes('ftypavif');
const isWebp = (/** @type {Buffer} */ b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';

test('AVIF is chosen only when the Accept header lists it', () => {
    assert.strictEqual(pickFormat('image/avif,image/webp,*/*'), 'avif');
    assert.strictEqual(pickFormat('image/webp,*/*'), 'webp');
    assert.strictEqual(pickFormat(undefined), 'webp');
});

test('a variant is rendered as AVIF or WebP and cached per format', async () => {
    const src = await sample();
    const avif = await renderVariant('k|1', src, 640, 'avif');
    const webp = await renderVariant('k|1', src, 640, 'webp');
    assert.ok(avif && isAvif(avif));
    assert.ok(webp && isWebp(webp));
    assert.strictEqual((await sharp(avif).metadata()).width, 640);
});

test('an undecodable source yields null instead of throwing', async () => {
    assert.strictEqual(await renderVariant('bad|1', Buffer.from('not an image'), 640, 'avif'), null);
});

test('an image narrower than the width is not enlarged', async () => {
    assert.strictEqual(await resize(await sample(300), 640, 'webp'), null);
});
