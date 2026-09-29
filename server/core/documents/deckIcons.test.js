/**
 * Icons on slides: names resolve (with the spellings people use), the SVG is
 * self-contained, the PNG is a real bitmap the .pptx can carry.
 *
 * Run: node --test --test-force-exit core/documents/deckIcons.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const icons = require('./deckIcons');

test('names: Lucide kebab-case, common aliases, case/space tolerant; unknown is null', () => {
    assert.strictEqual(icons.normaliseIconName('wifi-off'), 'wifi-off');
    assert.strictEqual(icons.normaliseIconName('Wifi Off'), 'wifi-off');
    assert.strictEqual(icons.normaliseIconName('tools'), 'wrench');
    assert.strictEqual(icons.normaliseIconName('home'), 'house');
    assert.strictEqual(icons.normaliseIconName(':shield:'), 'shield');
    assert.strictEqual(icons.normaliseIconName('nope-nope'), null);
    assert.ok(icons.iconNames().length >= 100);
});

test('svg: a stroked 24-grid drawing in the asked colour, nothing external', () => {
    const svg = icons.iconSvg('shield', '#FFFFFF', { size: 32 });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF"/);
    assert.match(svg, /<path d="/);
    assert.doesNotMatch(svg, /href|url\(|<script/);
    assert.strictEqual(icons.iconSvg('nope'), '');
});

test('png: a bitmap of the asked size, cached', async () => {
    const a = await icons.iconPng('workflow', '#0489D2', 96);
    assert.match(a, /^data:image\/png;base64,/);
    const sharp = require('sharp');
    const meta = await sharp(Buffer.from(a.slice(a.indexOf(',') + 1), 'base64')).metadata();
    assert.strictEqual(meta.width, 96);
    assert.strictEqual(await icons.iconPng('workflow', '#0489D2', 96), a, 'same name × colour × size is served from the cache');
    assert.strictEqual(await icons.iconPng('nope'), null);
});
