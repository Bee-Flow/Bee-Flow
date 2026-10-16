// @typecheck
const test = require('node:test');
const assert = require('node:assert');
const { renderBlocks, renderBlocksWithHints } = require('./renderBlocks');

const img = (key, extra = {}) => ({ kind: 'image', src: `cms/${key}.png`, alt: key, ...extra });
const block = (content, id = 'b') => ({ id, type: 'feature', content });

test('the first image of the first blocks is eager, high priority, and has a srcset', () => {
    const { html, heroImage, headLinks } = renderBlocksWithHints([block({ media: img('1-a-hero') })]);
    assert.strictEqual(headLinks.length, 1);
    assert.match(headLinks[0], /^<link rel="preload" as="image" href="\/api\/cms\/asset\/cms\/1-a-hero\.png" imagesrcset=/);
    assert.match(html, /<img src="\/api\/cms\/asset\/cms\/1-a-hero\.png" srcset="[^"]*\?w=640 640w[^"]*" sizes="[^"]+" alt="1-a-hero" loading="eager" fetchpriority="high" decoding="async">/);
    assert.ok(heroImage);
    assert.strictEqual(heroImage.src, '/api/cms/asset/cms/1-a-hero.png');
    assert.ok(heroImage.srcset && heroImage.sizes);
});

test('only one image is eager; later images and images below the second block stay lazy', () => {
    const { html } = renderBlocksWithHints([
        block({ items: [{ media: img('1-a-one') }, { media: img('1-a-two') }] }, 'b1'),
        block({ title: 'Middle' }, 'b2'),
        block({ media: img('1-a-three') }, 'b3'),
    ]);
    assert.strictEqual((html.match(/loading="eager"/g) || []).length, 1);
    assert.match(html, /1-a-two\.png"[^>]*loading="lazy"/);
    assert.match(html, /1-a-three\.png"[^>]*loading="lazy"/);
    assert.ok(!html.includes('fetchpriority="high" decoding="async"><img') );
});

test('an image in the third rendered block is never eager and gives no hero', () => {
    const { html, heroImage } = renderBlocksWithHints([
        block({ title: 'A' }, 'b1'), block({ title: 'B' }, 'b2'), block({ media: img('1-a-late') }, 'b3'),
    ]);
    assert.ok(!html.includes('loading="eager"'));
    assert.strictEqual(heroImage, null);
});

test('images in a multi-item grid get column based sizes', () => {
    const { html } = renderBlocksWithHints([
        block({ title: 'Top' }, 'b1'),
        block({ items: [{ media: img('1-a-x') }, { media: img('1-a-y') }, { media: img('1-a-z') }] }, 'b2'),
    ]);
    assert.match(html, /sizes="\(min-width: 1024px\) calc\(\(min\(100vw, 1200px\) - 96px\) \/ 3\), 100vw"/);
});

test('external and svg images keep a plain src without srcset', () => {
    const { html, heroImage } = renderBlocksWithHints([block({ media: { kind: 'image', src: '/img/a.svg', alt: 'a' } })]);
    assert.ok(!html.includes('srcset='));
    assert.ok(heroImage && heroImage.srcset === undefined);
});

test('renderBlocks still returns the HTML string', () => {
    assert.strictEqual(typeof renderBlocks([block({ title: 'Hi' })]), 'string');
});
