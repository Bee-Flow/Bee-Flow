// @typecheck noImplicitAny
/**
 * The feature-demo block's poster and caption (issue #251): seeded defaults and
 * the validator warnings an AI builder turn gets back.
 *
 * Run: node --test cmsBuilder/featureDemoBlock.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { BLOCK_DEFAULTS } = require('../i18n/defaults/cmsDefaults');
const { validateSiteDraft } = require('./validate');

/** @param {Record<string, unknown>} content */
const codes = (content) => validateSiteDraft(/** @type {Parameters<typeof validateSiteDraft>[0]} */ ({
    site: { pages: [{ id: 'p1', slug: 'demo', title: 'Demo' }] },
    pages: new Map([['p1', { blocks: [{ id: 'b1', type: 'feature-demo', content }] }]]),
})).warnings.map((w) => w.code);

test('a new feature-demo block starts with an empty poster and caption', () => {
    assert.strictEqual(BLOCK_DEFAULTS['feature-demo'].poster, '');
    assert.strictEqual(BLOCK_DEFAULTS['feature-demo'].caption, '');
});

test('a string poster and caption are accepted', () => {
    assert.deepStrictEqual(codes({ feature: 'agents', poster: '/api/cms/asset/cms/a.png', caption: 'Pick an agent.' }), []);
});

test('a poster or caption that is not a string is flagged', () => {
    assert.deepStrictEqual(codes({ feature: 'agents', poster: { src: '/a.png' } }), ['demo_poster_not_text']);
    assert.deepStrictEqual(codes({ feature: 'agents', caption: 42 }), ['demo_caption_not_text']);
});
