'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderBlocks } = require('./renderBlocks');
const { sanitizeBlocks } = require('../../stores/cms/pages');
const { BLOCK_DEFAULTS, BLOCK_TYPE_IDS } = require('../../i18n/defaults/cmsDefaults');

const page = (blocks) => renderBlocks(blocks, { fallbackTitle: 'Page' });

test('a scroll story reaches the crawler as ordered headings and prose', () => {
    const html = page([{ type: 'scrollStory', content: {
        title: 'Story', steps: [
            { title: 'First step', body: 'Does the first thing.', media: { kind: 'image', src: 'cms/a.png', alt: 'Shot one' } },
            { title: 'Second step', body: 'Does the second thing.' },
        ],
    } }]);
    assert.ok(html.indexOf('First step') < html.indexOf('Second step'));
    assert.match(html, /Does the second thing\./);
    assert.match(html, /alt="Shot one"/);
});

test('tour hotspot labels and explanations are rendered, their coordinates are not', () => {
    const html = page([{ type: 'tour', content: {
        title: 'Tour', steps: [{ title: 'Inbox', media: { kind: 'image', src: 'cms/a.png', alt: '' },
            hotspots: [{ x: 12, y: 80, label: 'Filter bar', body: 'Narrow the list.' }] }],
    } }]);
    assert.match(html, /Filter bar/);
    assert.match(html, /Narrow the list\./);
    assert.doesNotMatch(html, /\b80\b/);
});

test('both new block types are known to the store and have defaults', () => {
    for (const type of ['scrollStory', 'tour']) {
        assert.ok(BLOCK_TYPE_IDS.includes(type));
        assert.ok(Array.isArray(BLOCK_DEFAULTS[type].steps));
    }
    const { blocks, dropped } = sanitizeBlocks([{ type: 'scroll-story', content: {} }, { type: 'product-tour', content: {} }]);
    assert.deepEqual(blocks.map(b => b.type), ['scrollStory', 'tour']);
    assert.deepEqual(dropped, []);
});
