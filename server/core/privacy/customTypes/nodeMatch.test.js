'use strict';
/**
 * The Node matcher for `words` and `pattern` types (the one production and
 * the test bench share), the literal automaton under it, and the time-boxed
 * worker for migrated V8 patterns.
 *
 * Run: cd server && node --test core/privacy/customTypes/nodeMatch.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { AhoCorasick, foldString } = require('./ahoCorasick');
const { compileTypes } = require('./compile');
const { matchNode, MAX_SPANS_PER_TYPE } = require('./nodeMatch');
const { _resetLegacyRunner, runLegacySync } = require('./legacyRunner');

test.after(() => _resetLegacyRunner());

const W = (id, values, over = {}) => ({ id, name: id, method: 'words', tokenKey: 'k', words: { values, caseSensitive: false, wholeWord: true, ...over } });
const P = (id, source, over = {}) => ({ id, name: id, method: 'pattern', tokenKey: 'k', pattern: { source, caseSensitive: false, engine: 're2', ...over } });
const slices = (text, r) => r.spans.map(s => text.slice(s.start, s.end));

test('the automaton finds every occurrence, overlapping ones included', () => {
    const ac = new AhoCorasick();
    for (const w of ['he', 'she', 'his', 'hers']) ac.add(w, { len: w.length, w });
    const found = [];
    ac.search('ushers', false, (s, e, p) => found.push([s, e, p.w]));
    assert.deepEqual(found.sort(), [[1, 4, 'she'], [2, 4, 'he'], [2, 6, 'hers']].sort());
});

test('case folding keeps every offset (one code unit in, one out)', () => {
    for (const s of ['İstanbul', 'Straße', 'ΟΔΟΣ', 'x😀y', 'ǅemal']) {
        assert.equal(foldString(s).length, s.length, s);
    }
    const text = 'Meet FALCON, falcon and Falcon at ΟΔΟΣ now';
    const r = matchNode(text, [W('cdt_0000000001', ['falcon', 'οδος'])]);
    assert.deepEqual(slices(text, r), ['FALCON', 'falcon', 'Falcon', 'ΟΔΟΣ']);
});

test('whole-word matching uses Unicode letters and digits as the word characters', () => {
    // "Falcon" + U+0301 (a combining accent) is a different word, not a match.
    const text = 'Falcon falconry xFalcon Falcon9 Falcon. «Falcon» Falcon\u0301 end';
    const r = matchNode(text, [W('cdt_0000000001', ['Falcon'])]);
    assert.deepEqual(r.spans.map(s => s.start), [0, 32, 41]);
    assert.deepEqual(slices(text, r), ['Falcon', 'Falcon', 'Falcon']);
    // A value that starts or ends with a non-word character needs no boundary there.
    const t2 = 'use C++11 and #tag-x';
    assert.deepEqual(slices(t2, matchNode(t2, [W('cdt_0000000002', ['C++', '#tag'])])), ['C++', '#tag']);
    // Without whole-word matching it matches inside words (the migrated-literal parity).
    assert.equal(slices(text, matchNode(text, [W('cdt_0000000003', ['falcon'], { wholeWord: false })])).length, 7);
});

test('case-sensitive words match only their own spelling', () => {
    const text = 'aurora AURORA Aurora';
    const r = matchNode(text, [W('cdt_0000000001', ['Aurora'], { caseSensitive: true, wholeWord: false })]);
    assert.deepEqual(r.spans.map(s => s.start), [14]);
});

test('RE2 patterns: offsets in UTF-16, zero-width matches skipped', () => {
    const text = 'é😀 KL-12345 and kl-99999; 😀x';
    const r = matchNode(text, [P('cdt_0000000001', 'KL-\\d{5}'), P('cdt_0000000002', '\\b')]);
    assert.deepEqual(slices(text, r), ['KL-12345', 'kl-99999']);
    assert.equal(r.partial, false);
});

test('a type that cannot compile is reported, never matched', () => {
    const c = compileTypes([P('cdt_0000000001', '(?=x)'), W('cdt_0000000002', []), { id: 'cdt_0000000003', method: 'words', status: 'invalid', words: { values: ['x'] } }]);
    assert.deepEqual(c.invalid.map(i => [i.id, i.reason]), [
        ['cdt_0000000001', 'compile_failed'], ['cdt_0000000002', 'compile_failed'], ['cdt_0000000003', 'status_invalid'],
    ]);
    assert.deepEqual(matchNode('x', c).failed.sort(), ['cdt_0000000001', 'cdt_0000000002']);
});

test('a pathological list is bounded per type and reported partial', () => {
    const text = 'a'.repeat(MAX_SPANS_PER_TYPE + 10);
    const r = matchNode(text, [W('cdt_0000000001', ['a'], { wholeWord: false })]);
    assert.equal(r.spans.length, MAX_SPANS_PER_TYPE);
    assert.deepEqual(r.partialIds, ['cdt_0000000001']);
    assert.equal(r.partial, true);
});

test('migrated V8 patterns run in the worker, with their own semantics', () => {
    const text = 'TOPGEHEIM dossier KC-1234 hier';
    const r = matchNode(text, [
        P('cdt_0000000001', 'KC-(?=\\d{4})\\d{4}', { engine: 'v8-legacy', caseSensitive: true }),
        P('cdt_0000000002', '(\\w)\\1', { engine: 'v8-legacy' }),
    ]);
    assert.deepEqual(r.timedOut, []);
    assert.deepEqual(slices(text, r).sort(), ['KC-1234', 'ss']);
});

test('a catastrophic V8 pattern times out, is degraded, and is not retried for a while', () => {
    const evil = { id: 'cdt_00000000ee', source: '(a+)+$', caseSensitive: true };
    const text = `${'a'.repeat(40)}b`;
    const t0 = Date.now();
    const first = runLegacySync([evil], text, 50);
    assert.deepEqual(first.timedOut, ['cdt_00000000ee']);
    assert.ok(Date.now() - t0 < 2000, 'the budget bounds the wait (plus one worker start-up)');
    const t1 = Date.now();
    const second = runLegacySync([evil], text, 50);
    assert.deepEqual(second.timedOut, ['cdt_00000000ee']);
    assert.ok(Date.now() - t1 < 20, 'within the cool-down it is skipped outright');
    // The worker was replaced: an unrelated pattern still runs.
    const ok = runLegacySync([{ id: 'cdt_00000000ff', source: 'b$', caseSensitive: true }], text, 500);
    assert.deepEqual(ok.results.get('cdt_00000000ff'), [{ start: 40, end: 41 }]);
});
