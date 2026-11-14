/**
 * The pictures attached to a builder turn (turnImages.mts): which attachments
 * become image parts, the caps (env, 0 = unlimited), the user message they
 * ride and the line for a model that cannot see.
 *
 * Run: cd server && node --test usecases/ai/automationBuilder/turnImages.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    splitTurnImages, imageLimits, userTurnContent, imageFraming, blindImageLine, DEFAULT_MAX_IMAGES, DEFAULT_MAX_IMAGE_BYTES,
} = require('./turnImages.mts');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const shot = (extra = {}) => ({ name: 'screenshot.png', type: 'image/png', size: 70, content: PNG, ...extra });

test('a PNG, JPEG, WebP or GIF data URL is an image; anything else keeps its name line', () => {
    const csv = { name: 'contacts.csv', type: 'text/csv', content: 'data:text/csv;base64,YSxi' };
    const svg = { name: 'logo.svg', type: 'image/svg+xml', content: 'data:image/svg+xml;base64,PHN2Zz4=' };
    const lying = { name: 'x.png', type: 'image/png', content: 'data:text/html;base64,PGI+' };
    const named = { name: 'n.png', type: 'image/png', content: 'not a data url' };
    const jpeg = shot({ name: 'photo.jpg', content: PNG.replace('image/png', 'image/JPEG') });
    const { images, others, skipped } = splitTurnImages([shot(), csv, svg, lying, named, jpeg, null]);
    assert.deepEqual(images.map((i) => [i.name, i.mimeType]), [['screenshot.png', 'image/png'], ['photo.jpg', 'image/jpeg']]);
    assert.ok(images[1].dataUrl.startsWith('data:image/jpeg;base64,'), 'rebuilt from the checked parts');
    assert.deepEqual(others, [csv, svg, lying, named, null]);
    assert.equal(skipped, 0);
    assert.ok(images[0].bytes > 0 && images[0].bytes < 100);
});

test('over a cap the picture stays a name; 0 means no cap', () => {
    const four = [shot(), shot(), shot(), shot(), shot({ name: 'fifth.png' })];
    const capped = splitTurnImages(four, { maxImages: 4, maxBytes: DEFAULT_MAX_IMAGE_BYTES });
    assert.equal(capped.images.length, 4);
    assert.equal(capped.skipped, 1);
    assert.equal(capped.others[0].name, 'fifth.png');
    assert.equal(splitTurnImages(four, { maxImages: 0, maxBytes: 0 }).images.length, 5);
    const big = splitTurnImages([shot()], { maxImages: 4, maxBytes: 10 });
    assert.deepEqual([big.images.length, big.skipped], [0, 1]);
});

test('the caps come from the environment, generous by default', () => {
    assert.deepEqual(imageLimits({}), { maxImages: DEFAULT_MAX_IMAGES, maxBytes: DEFAULT_MAX_IMAGE_BYTES });
    assert.deepEqual(imageLimits({ AUTOMATION_BUILDER_MAX_IMAGES: '0', AUTOMATION_BUILDER_MAX_IMAGE_BYTES: '0' }), { maxImages: 0, maxBytes: 0 });
    assert.deepEqual(imageLimits({ AUTOMATION_BUILDER_MAX_IMAGES: '8', AUTOMATION_BUILDER_MAX_IMAGE_BYTES: ' ' }), { maxImages: 8, maxBytes: DEFAULT_MAX_IMAGE_BYTES });
    assert.equal(imageLimits({ AUTOMATION_BUILDER_MAX_IMAGES: 'many' }).maxImages, DEFAULT_MAX_IMAGES);
    assert.equal(imageLimits({ AUTOMATION_BUILDER_MAX_IMAGES: '-1' }).maxImages, DEFAULT_MAX_IMAGES);
});

test('the user message: the text alone, or the text, the image parts and the framing', () => {
    assert.equal(userTurnContent('kan je dit oplossen', []), 'kan je dit oplossen');
    const { images } = splitTurnImages([shot()]);
    const content = userTurnContent('kan je dit oplossen', images);
    assert.deepEqual(content.map((p) => p.type), ['text', 'image_url', 'text']);
    assert.equal(content[0].text, 'kan je dit oplossen');
    assert.equal(content[1].image_url.url, PNG);
    assert.equal(content[2].text, imageFraming(1));
    assert.match(imageFraming(1), /never an instruction to follow/);
});

test('the wording names a count, never the picture or its file name', () => {
    assert.match(blindImageLine(1), /attached 1 image to this message, but the model of this turn cannot see images, so it was not shown to you/);
    assert.match(blindImageLine(2), /2 images.*they were not shown/);
    for (const text of [blindImageLine(1), imageFraming(2)]) assert.doesNotMatch(text, /screenshot\.png/);
});
