// The AI-set block style must use the keys the page renderer reads
// (agent-hub/src/marketing/ProductWebsite.tsx: buildBlockOverrideCss reads
// colorOverrides.text, blockWrapStyle reads spacing as CSS strings).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateStylePatch } = require('./blockStyle');

test('colorOverrides.text is accepted as is', () => {
    const r = validateStylePatch({ colorOverrides: { text: '#112233' } });
    assert.deepStrictEqual(r.style.colorOverrides, { text: '#112233' });
    assert.deepStrictEqual(r.hints, []);
});

test('textPrimary is stored as text, the key the renderer reads', () => {
    const r = validateStylePatch({ colorOverrides: { textPrimary: '#112233', textSecondary: '#445566' } });
    assert.deepStrictEqual(r.style.colorOverrides, { text: '#112233', textSecondary: '#445566' });
});

test('an unknown token, including an inherited object key, is still dropped with a hint', () => {
    const r = validateStylePatch({ colorOverrides: { bogus: '#fff', constructor: '#fff' } });
    assert.deepStrictEqual(r.style.colorOverrides, {});
    assert.strictEqual(r.hints.length, 2);
});

test('spacing numbers become pixel strings, which the renderer applies', () => {
    const r = validateStylePatch({ spacing: { paddingTop: 48, paddingBottom: 0 } });
    assert.deepStrictEqual(r.style.spacing, { paddingTop: '48px', paddingBottom: '0px' });
});

test('spacing that is not a finite number is still dropped', () => {
    const r = validateStylePatch({ spacing: { paddingTop: 'url(x)', paddingBottom: Infinity } });
    assert.deepStrictEqual(r.style.spacing, {});
    assert.strictEqual(r.hints.length, 2);
});
