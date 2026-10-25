// @typecheck strict
/**
 * The customer-story blocks (issue #239): catalogue entries, seeded defaults
 * and the validator's warnings. The store/route/HTML side is covered by
 * stores/cms/stories.test.js and routes/cmsStories.test.js.
 *
 * Run: node --test cmsBuilder/storyBlocks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { BLOCK_DEFAULTS, BLOCK_TYPE_IDS, STORY_METRICS_MIN, STORY_METRICS_MAX, STORY_GRID_MAX } = require('../i18n/defaults/cmsDefaults');
const { validateSiteDraft } = require('./validate');

/** @param {string} type @param {Record<string, unknown>} content */
const codes = (type, content) => validateSiteDraft(/** @type {Parameters<typeof validateSiteDraft>[0]} */ ({
    site: { pages: [{ id: 'p1', slug: 'story', title: 'Story' }] },
    pages: new Map([['p1', { blocks: [{ id: 'b1', type, content }] }]]),
})).warnings.map((w) => w.code);

test('both blocks are in the catalogue with defaults', () => {
    assert.ok(BLOCK_TYPE_IDS.includes('story-header'));
    assert.ok(BLOCK_TYPE_IDS.includes('customer-stories'));
    assert.ok(BLOCK_DEFAULTS['story-header'].metrics.length >= STORY_METRICS_MIN);
    assert.ok(BLOCK_DEFAULTS['customer-stories'].limit <= STORY_GRID_MAX);
});

test('the seeded story header validates clean', () => {
    assert.deepStrictEqual(codes('story-header', BLOCK_DEFAULTS['story-header']), []);
});

test('a header without a customer, or with too few / many metrics, is a warning', () => {
    assert.ok(codes('story-header', { ...BLOCK_DEFAULTS['story-header'], customer: ' ' }).includes('story_missing_customer'));
    assert.ok(codes('story-header', { ...BLOCK_DEFAULTS['story-header'], metrics: [{ stat: '1', label: 'a' }] }).includes('story_metrics_count'));
    const many = Array.from({ length: STORY_METRICS_MAX + 1 }, () => ({ stat: '1', label: 'a' }));
    assert.ok(codes('story-header', { ...BLOCK_DEFAULTS['story-header'], metrics: many }).includes('story_metrics_count'));
});
