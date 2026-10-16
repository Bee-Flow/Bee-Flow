// @typecheck
const test = require('node:test');
const assert = require('node:assert');
const { BLOCK_VARIANTS, BLOCK_DEFAULTS } = require('../i18n/defaults/cmsDefaults');

test('socialProof offers the logo wall, numbers, stats only and chips; classic stays the default', () => {
    assert.deepStrictEqual(BLOCK_VARIANTS.socialProof, ['classic', 'numbers', 'stats', 'chips']);
    assert.strictEqual(BLOCK_DEFAULTS.socialProof.variant, 'classic');
});

test('a new socialProof block starts with empty logos, stats and chips lists', () => {
    assert.deepStrictEqual(BLOCK_DEFAULTS.socialProof.logos, []);
    assert.deepStrictEqual(BLOCK_DEFAULTS.socialProof.stats, []);
    assert.deepStrictEqual(BLOCK_DEFAULTS.socialProof.chips, []);
});
