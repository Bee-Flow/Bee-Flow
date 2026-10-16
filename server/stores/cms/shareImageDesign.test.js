const test = require('node:test');
const assert = require('node:assert');
const { sanitizeDesign } = require('./shared');

test('the share-image setting defaults to the light card with the honeycomb', () => {
    assert.deepStrictEqual(sanitizeDesign({}).shareImage, { template: 'light', motif: true });
    assert.deepStrictEqual(sanitizeDesign(null).shareImage, { template: 'light', motif: true });
});

test('a known template and motif:false are kept; anything else falls back', () => {
    assert.deepStrictEqual(sanitizeDesign({ shareImage: { template: 'brand', motif: false } }).shareImage, { template: 'brand', motif: false });
    assert.deepStrictEqual(sanitizeDesign({ shareImage: { template: '<script>', motif: 'no' } }).shareImage, { template: 'light', motif: true });
    assert.deepStrictEqual(sanitizeDesign({ shareImage: 'brand' }).shareImage, { template: 'light', motif: true });
});
