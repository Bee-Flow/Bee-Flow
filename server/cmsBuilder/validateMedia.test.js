// @typecheck
const test = require('node:test');
const assert = require('node:assert');
const { checkPageMedia, MAX_MEDIA } = require('./validateMedia');

const img = (width) => ({ kind: 'image', src: '/a.png', alt: 'a', width, height: 100 });
const codes = (blocks) => {
    const w = [];
    checkPageMedia('p1', 'Home', blocks, w);
    return w.map((x) => x.code);
};

test('a wide image in the first two blocks is flagged, a later or narrower one is not', () => {
    assert.deepStrictEqual(codes([{ content: { media: img(3000) } }]), ['heavy_hero_image']);
    assert.deepStrictEqual(codes([{ content: {} }, { content: { media: img(2400) } }]), ['heavy_hero_image']);
    assert.deepStrictEqual(codes([{ content: { media: img(1600) } }]), []);
    assert.deepStrictEqual(codes([{ content: {} }, { content: {} }, { content: { media: img(3000) } }]), []);
    assert.deepStrictEqual(codes([{ content: { media: { kind: 'image', src: '/a.png', alt: '' } } }]), []);
});

test('an autoplay video is flagged once per page, a clip with controls is not', () => {
    const v = { kind: 'video-silent', src: '/v.mp4' };
    assert.deepStrictEqual(codes([{ content: { media: v } }, { content: { items: [{ media: v }] } }]), ['autoplay_video']);
    assert.deepStrictEqual(codes([{ content: { media: { kind: 'video', src: '/v.mp4' } } }]), []);
});

test('more than the media limit on one page is flagged', () => {
    const items = Array.from({ length: MAX_MEDIA + 1 }, () => ({ media: img(800) }));
    assert.deepStrictEqual(codes([{ content: { items } }]), ['many_media']);
    assert.deepStrictEqual(codes([{ content: { items: items.slice(1) } }]), []);
});
