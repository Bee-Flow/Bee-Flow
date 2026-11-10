'use strict';

/**
 * The colour forms a block's `style.colorOverrides` may hold (i18n/defaults/blockStyleEnums.js),
 * at the three places that read them: the stylePatch validator (cmsBuilder/blockStyle.js), the
 * store's block sanitiser (stores/cms/pages.js) and, through the generated copy, the renderer
 * (agent-hub/src/marketing/blockOverrideCss.test.ts).
 *
 * Run: cd server && node --test cmsBuilder/blockColorOverrides.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCssColor, cleanColorOverrides, sanitizeBlockDesignStyle } = require('../i18n/defaults/blockStyleEnums');
const { validateStylePatch } = require('./blockStyle');

const COLOURS = [
    '#fff', '#FFFF', '#112233', '#11223344', ' #a1B2c3 ',
    'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'RGB(10 20 30 / 50%)', 'hsl(210, 50%, 40%)', 'hsla(210deg 50% 40% / .5)',
    'hwb(194 0% 0%)', 'lab(29.2 39.3 20)', 'lch(52% 72 56)', 'oklab(59% 0.1 0.1)', 'oklch(60% 0.15 50)', 'rgb(none 0 -1e1)',
    'var(--brand-primary)', 'var(--Honey_500)',
    'red', 'transparent', 'currentColor', 'rebeccapurple',
];
const NOT_COLOURS = [
    '', ' ', '#', '#12', '#12345', '#1234567', '#123456789', '#ggg', '#fff;',
    'red; background: url(//x)', 'red } body { display: none', 'rgb(1,2,3); color: red', 'rgb(1,2,3', 'rgb()', 'rgb(1,(2),3)',
    'url(https://example.test/x)', 'expression(1)', 'calc(1px)', 'color-mix(in srgb, red, blue)', 'image-set("x")',
    'var(--a, red)', 'var(-a)', 'var(--)', 'var(--a)b', 'light-dark', 'red/**/', 'red\nblue', '"red"', 'r\\65 d', '</style>',
    `#${'f'.repeat(80)}`, 'a'.repeat(65),
    null, undefined, 3, true, ['#fff'], { toString: () => '#fff' },
];

test('isCssColor: hex, the functional notations, var(--name) and keywords', () => {
    for (const v of COLOURS) assert.equal(isCssColor(v), true, JSON.stringify(v));
});

test('isCssColor: nothing else', () => {
    for (const v of NOT_COLOURS) assert.equal(isCssColor(v), false, JSON.stringify(v));
});

test('cleanColorOverrides: colours and the empty string stay, as they were written', () => {
    const map = Object.fromEntries(COLOURS.map((v, i) => [`k${i}`, v]));
    assert.deepEqual(cleanColorOverrides({ ...map, cleared: '' }), { ...map, cleared: '' });
});

test('cleanColorOverrides: other values go; what is not a map gives an empty one', () => {
    const map = Object.fromEntries(NOT_COLOURS.filter((v) => v !== '').map((v, i) => [`k${i}`, v]));
    assert.deepEqual(cleanColorOverrides({ ...map, primary: '#112233' }), { primary: '#112233' });
    for (const v of [null, undefined, 'red', 3, ['#fff']]) assert.deepEqual(cleanColorOverrides(v), {});
});

test('validateStylePatch: a colour is stored as given, the empty string still clears', () => {
    const colorOverrides = { primary: '#112233', accent: 'rgba(1, 2, 3, 0.5)', surface: 'var(--brand-bg)', text: 'white', background: '' };
    const r = validateStylePatch({ colorOverrides });
    assert.deepEqual(r.style.colorOverrides, colorOverrides);
    assert.deepEqual(r.hints, []);
});

test('validateStylePatch: a value that is not a colour is dropped with a hint; the rest is stored', () => {
    const r = validateStylePatch({ colorOverrides: { primary: 'red; background: url(//x)', accent: '#abc', textPrimary: 'url(x)' } });
    assert.deepEqual(r.style.colorOverrides, { accent: '#abc' });
    assert.equal(r.hints.length, 2);
    assert.match(r.hints[0], /^colorOverrides\.primary: not a color, dropped\./);
    assert.match(r.hints[1], /^colorOverrides\.textPrimary: not a color, dropped\./);
});

test('sanitizeBlockDesignStyle: a style without colorOverrides gets none; valid ones are unchanged', () => {
    assert.deepEqual(sanitizeBlockDesignStyle({ band: 'dark' }), { band: 'dark' });
    const style = { band: 'dark', colorOverrides: { primary: '#112233', text: 'rgb(0 0 0 / 80%)' }, spacing: { paddingTop: '4rem' } };
    assert.deepEqual(sanitizeBlockDesignStyle(style), style);
});

test('sanitizeBlockDesignStyle: colorOverrides loses what is not a colour', () => {
    const out = sanitizeBlockDesignStyle({ colorOverrides: { primary: '#112233', accent: 'red } * { color: blue' }, cssClass: 'x' });
    assert.deepEqual(out, { colorOverrides: { primary: '#112233' }, cssClass: 'x' });
    assert.deepEqual(sanitizeBlockDesignStyle({ colorOverrides: 'red' }), { colorOverrides: {} });
});

test('the store sanitiser applies the same rule to a saved block', () => {
    const { sanitizeBlock } = require('../stores/cms/pages');
    const valid = { colorOverrides: { primary: '#112233', text: 'var(--brand-text)' }, band: 'dark' };
    assert.deepEqual(sanitizeBlock({ id: 'blk_1', type: 'hero', content: {}, style: valid }).style, valid);
    const block = sanitizeBlock({ id: 'blk_1', type: 'hero', content: {}, style: { colorOverrides: { primary: '#112233', accent: 'url(x)' } } });
    assert.deepEqual(block.style.colorOverrides, { primary: '#112233' });
});
