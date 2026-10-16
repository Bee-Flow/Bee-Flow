// @typecheck
const test = require('node:test');
const assert = require('node:assert');
const { variantSrcSet, columnSizes, DEFAULT_SIZES, preloadLink } = require('./imageDelivery');

test('an uploaded image gets a srcset of the five variant widths', () => {
    const set = variantSrcSet('/api/cms/asset/cms/1-a-hero.png');
    assert.ok(set);
    assert.strictEqual(set.split(', ').length, 5);
    assert.match(set, /\/api\/cms\/asset\/cms\/1-a-hero\.png\?w=640 640w/);
});

test('svg, video, external and already-sized urls get no srcset', () => {
    for (const u of ['/api/cms/asset/cms/1-a.svg', '/api/cms/asset/cms/1-a.mp4',
        'https://example.com/a.png', '/api/cms/asset/cms/1-a.png?w=320', '/img/a.png']) {
        assert.strictEqual(variantSrcSet(u), undefined, u);
    }
});

test('sizes follow the column count; one column is the content width', () => {
    assert.strictEqual(columnSizes(1), DEFAULT_SIZES);
    assert.strictEqual(columnSizes(0), DEFAULT_SIZES);
    assert.match(columnSizes(3), /^\(min-width: 1024px\) calc\(\(min\(100vw, 1200px\) - 96px\) \/ 3\), 100vw$/);
});

test('the preload link carries the srcset, sizes and a high fetch priority, escaped', () => {
    const link = preloadLink({ src: '/api/cms/asset/cms/1-a.png', srcset: 'a 1w', sizes: DEFAULT_SIZES });
    assert.match(link, /^<link rel="preload" as="image" href="\/api\/cms\/asset\/cms\/1-a\.png" imagesrcset="a 1w" imagesizes="[^"]+" fetchpriority="high">$/);
    assert.ok(!preloadLink({ src: '/a"><x', srcset: undefined, sizes: undefined }).includes('"><x'));
});
