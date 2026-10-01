/**
 * renderText and renderCompose. REGRESSION for two confirmed bugs:
 *   - "Text mixed with a list or an object renders as raw JSON": a list or
 *     a record in a text is readable lines, never JSON;
 *   - "A list with no sample data defaults to join(), which gives
 *     '[object Object]' once real data holds objects": the rendering goes by
 *     what the run holds, so records render as rows whatever the sample was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderText, renderCompose, inlineText } from './render.mjs';

test('values, lists, tables and records as text', () => {
    assert.equal(renderText(undefined), '');
    assert.equal(renderText(null), '');
    assert.equal(renderText(0), '0');
    assert.equal(renderText(false), 'false');
    assert.equal(renderText('x'), 'x');
    assert.equal(renderText(['a', 'b']), 'a\nb');
    assert.equal(renderText(['a', 'b'], { join: 'comma' }), 'a, b');
    assert.equal(renderText(['a', 'b'], { join: 'bullets' }), '- a\n- b');
    assert.equal(renderText(['a', null, '', 'b']), 'a\nb', 'empty items are left out');
    assert.equal(renderText([{ product: 'Stoel', qty: 2, prijs: '€40' }, { product: 'Tafel', qty: 1 }]), 'Stoel · 2 · €40\nTafel · 1');
    assert.equal(renderText([[1, 2], [3]]), '1, 2\n3');
    assert.equal(renderText({ naam: 'Jan', plaats: 'Utrecht', leeg: null }), 'naam: Jan\nplaats: Utrecht');
    assert.equal(renderText({ adres: { straat: 'A', nr: 1 } }), 'adres: A · 1');
    assert.equal(inlineText([{ a: [1, 2] }]), '1, 2');
});

test('never JSON, never [object Object]', () => {
    const text = renderText([{ id: 1, klant: { naam: 'Ada' } }, { id: 2, lines: [{ sku: 'A' }] }]);
    assert.ok(!/[{}[\]"]/.test(text), text);
    assert.ok(!text.includes('[object Object]'), text);
});

test('compose: literal parts as they are, value parts as text, json only when asked', () => {
    const values = { a: 'Jan', b: ['x', 'y'], c: { k: 1 }, d: undefined };
    const resolve = (p) => values[p.key];
    const out = renderCompose({ parts: ['Hoi ', { key: 'a' }, ': ', { key: 'b', join: 'comma' }, ' ', { key: 'c', as: 'json' }, '|', { key: 'd' }] }, resolve);
    assert.equal(out, 'Hoi Jan: x, y {"k":1}|');
    assert.equal(renderCompose(null, resolve), '');
});
