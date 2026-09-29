'use strict';
/**
 * The one merge rule for scans with custom types, and the spanOverlap option
 * it rides on (whose default must stay exactly what every other caller had).
 *
 * Run: cd server && node --test core/privacy/customTypes/merge.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSpanOverlaps } = require('../../dlp/spanOverlap');
const { mergeEntities, spansToEntities } = require('./merge');

const text = 'Contact Falcon Holdings BV about KL-12345 today';
const e = (category, offset, length, extra = {}) => ({
    category, label: category, offset, length, text: text.slice(offset, offset + length), confidence: 0.8, ...extra,
});
const METHODS = { cdt_00000000a1: 'words', cdt_00000000b2: 'pattern', cdt_00000000c3: 'ai' };
const ORDER = { cdt_00000000a1: 0, cdt_00000000b2: 1, cdt_00000000c3: 2 };
const plan = {
    methodFor: (id) => METHODS[id] || null,
    orderFor: (id) => ORDER[id] ?? 99,
    labelFor: (id) => `Name of ${id}`,
};

test('spanOverlap default: unchanged, no alsoCategories', () => {
    const out = resolveSpanOverlaps([e('Organization', 8, 20), e('Person', 8, 6, { severity: 'high' })], text);
    assert.equal(out.length, 1);
    assert.equal(out[0].category, 'Person', 'severity still wins by default');
    assert.equal(out[0].length, 20, 'union extent');
    assert.equal('alsoCategories' in out[0], false);
});

test('a custom type beats a built-in one; the union is kept, the loser listed', () => {
    const out = mergeEntities([e('Organization', 8, 20), e('cdt_00000000a1', 8, 6)], text, plan);
    assert.equal(out.length, 1);
    assert.equal(out[0].category, 'cdt_00000000a1');
    assert.equal(out[0].label, 'Name of cdt_00000000a1');
    assert.equal(out[0].offset, 8);
    assert.equal(out[0].length, 20);
    assert.equal(out[0].text, text.slice(8, 28), 'text re-derived from the source');
    assert.deepEqual(out[0].alsoCategories, ['Organization']);
});

test('between custom types: words > pattern > ai, then longer, then confidence, then order', () => {
    let out = mergeEntities([e('cdt_00000000c3', 33, 8, { confidence: 0.99 }), e('cdt_00000000b2', 33, 8, { confidence: 1 })], text, plan);
    assert.equal(out[0].category, 'cdt_00000000b2');
    out = mergeEntities([e('cdt_00000000b2', 33, 8), e('cdt_00000000a1', 33, 8)], text, plan);
    assert.equal(out[0].category, 'cdt_00000000a1');
    // A fuzzy ai span reaching past an exact match must not take its name
    // (seen against the real guard: "contract KL-12345" around "KL-12345").
    out = mergeEntities([e('cdt_00000000c3', 24, 17), e('cdt_00000000b2', 33, 8)], text, plan);
    assert.equal(out.length, 1);
    assert.equal(out[0].category, 'cdt_00000000b2', 'the exact method names the span');
    assert.deepEqual([out[0].offset, out[0].length], [24, 17], 'the union extent is kept');
    out = mergeEntities([e('cdt_00000000a1', 33, 3), e('cdt_00000000c3', 33, 8)], text, plan);
    assert.equal(out[0].category, 'cdt_00000000a1', 'method wins before length');
    const same = { cdt_0000000001: 'ai', cdt_0000000002: 'ai' };
    const p1 = { ...plan, methodFor: (id) => same[id], orderFor: () => 0 };
    out = mergeEntities([e('cdt_0000000001', 33, 3), e('cdt_0000000002', 33, 8)], text, p1);
    assert.equal(out[0].category, 'cdt_0000000002', 'within one method, longer wins');
    const twin = { cdt_0000000001: 'words', cdt_0000000002: 'words' };
    const p2 = { ...plan, methodFor: (id) => twin[id], orderFor: (id) => (id === 'cdt_0000000002' ? 0 : 1) };
    out = mergeEntities([e('cdt_0000000001', 33, 8, { confidence: 1 }), e('cdt_0000000002', 33, 8, { confidence: 1 })], text, p2);
    assert.equal(out[0].category, 'cdt_0000000002', 'definition order last');
});

test('output is disjoint and sorted, adjacent spans stay separate', () => {
    const out = mergeEntities([
        e('cdt_00000000b2', 33, 8), e('Organization', 8, 15), e('cdt_00000000a1', 8, 6), e('cdt_00000000a1', 24, 2),
    ], text, plan);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].offset >= out[i - 1].offset + out[i - 1].length);
    assert.deepEqual(out.map(x => x.offset), [8, 24, 33]);
});

test('Node spans become entities with the guard entity shape', () => {
    assert.deepEqual(spansToEntities([{ start: 33, end: 41, typeId: 'cdt_00000000b2' }], text), [{
        text: 'KL-12345', category: 'cdt_00000000b2', subCategory: null, confidence: 1, offset: 33, length: 8, label: 'cdt_00000000b2',
    }]);
});
