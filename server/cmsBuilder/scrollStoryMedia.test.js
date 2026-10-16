// @typecheck
/**
 * scrollStory steps only show images (the sticky panel is inert and hidden from
 * assistive technology, so a clip with controls would be unreachable).
 *
 * Run: node --test cmsBuilder/scrollStoryMedia.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateSiteDraft } = require('./validate');

/** @param {unknown[]} steps */
const warningsFor = (steps) => validateSiteDraft({
    site: { pages: [{ id: 'p1', slug: 'story', title: 'Story' }] },
    pages: new Map([['p1', { blocks: [{ id: 'b1', type: 'scrollStory', content: { title: 'T', steps } }] }]]),
}).warnings.filter((w) => w.code === 'scroll_story_media');

test('image media and steps without media pass', () => {
    assert.deepStrictEqual(warningsFor([
        { title: 'A', body: 'x', media: { kind: 'image', src: 'cms/a.png', alt: 'a' } },
        { title: 'B', body: 'y', media: { src: 'cms/b.png' } },
        { title: 'C', body: 'z' },
    ]), []);
});

test('a clip or a video step is reported with its path', () => {
    const w = warningsFor([
        { title: 'A', media: { kind: 'clip', src: 'cms/a.mp4' } },
        { title: 'B', media: { kind: 'video', src: 'cms/b.mp4' } },
    ]);
    assert.deepStrictEqual(w.map((x) => x.path), [
        'pages.p1.blocks[0].content.steps[0].media',
        'pages.p1.blocks[0].content.steps[1].media',
    ]);
});
