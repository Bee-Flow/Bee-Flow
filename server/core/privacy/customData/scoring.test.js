'use strict';
/**
 * Sentence scoring: coverage ≥ 50% is a find (partial below 100%), a
 * prediction that touches no gold is a false alarm, no gold means 'found'.
 *
 * Run: node --test core/privacy/customData/scoring.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeSpans, scoreSentence, summarize, fScore } = require('./scoring');

const S = (gold) => ({ text: 'x'.repeat(100), gold });

test('an exact prediction is a hit and the verdict is correct', () => {
    const r = scoreSentence(S([{ start: 10, end: 18 }]), [{ start: 10, end: 18 }]);
    assert.deepEqual(r.marks, [{ start: 10, end: 18, kind: 'hit' }]);
    assert.equal(r.verdict, 'correct');
    assert.deepEqual([r.found, r.total, r.falseAlarms], [1, 1, 0]);
});

test('half covered is found but partial; less than half is missed', () => {
    const half = scoreSentence(S([{ start: 10, end: 20 }]), [{ start: 15, end: 20 }]);
    assert.deepEqual(half.marks, [{ start: 10, end: 20, kind: 'hit', partial: true }]);
    assert.equal(half.verdict, 'correct');
    const less = scoreSentence(S([{ start: 10, end: 20 }]), [{ start: 16, end: 20 }]);
    assert.deepEqual(less.marks, [{ start: 10, end: 20, kind: 'missed' }]);
    assert.equal(less.verdict, 'missed');
    assert.equal(less.falseAlarms, 0, 'an overlapping prediction is not a false alarm');
});

test('two predictions together can cover one gold span', () => {
    const r = scoreSentence(S([{ start: 10, end: 20 }]), [{ start: 10, end: 13 }, { start: 13, end: 17 }]);
    assert.equal(r.marks[0].kind, 'hit');
    assert.equal(r.marks[0].partial, true);
});

test('a prediction outside every gold span is a false alarm', () => {
    const r = scoreSentence(S([{ start: 10, end: 20 }]), [{ start: 10, end: 20 }, { start: 40, end: 45 }]);
    assert.deepEqual(r.marks, [{ start: 10, end: 20, kind: 'hit' }, { start: 40, end: 45, kind: 'false_alarm' }]);
    assert.equal(r.verdict, 'false_alarm');
    const mixed = scoreSentence(S([{ start: 10, end: 20 }]), [{ start: 40, end: 45 }]);
    assert.equal(mixed.verdict, 'mixed');
});

test('a near miss (gold: []) scores every find as a false alarm', () => {
    const r = scoreSentence(S([]), [{ start: 1, end: 4 }]);
    assert.equal(r.verdict, 'false_alarm');
    assert.equal(r.falseAlarms, 1);
    assert.equal(scoreSentence(S([]), []).verdict, 'correct');
});

test('no gold at all: finds are reported as found, nothing is scored', () => {
    const r = scoreSentence({ text: 'abc' }, [{ start: 0, end: 3 }]);
    assert.deepEqual(r.marks, [{ start: 0, end: 3, kind: 'found' }]);
    assert.equal(r.verdict, 'no_gold');
    assert.deepEqual([r.found, r.total, r.falseAlarms], [0, 0, 0]);
});

test('touching gold spans stay two; touching predictions merge', () => {
    const r = scoreSentence(S([{ start: 0, end: 5 }, { start: 5, end: 10 }]), [{ start: 0, end: 10 }]);
    assert.equal(r.total, 2);
    assert.equal(r.found, 2);
    assert.deepEqual(mergeSpans([{ start: 5, end: 8 }, { start: 0, end: 5 }, { start: 20, end: 21 }]), [{ start: 0, end: 8 }, { start: 20, end: 21 }]);
});

test('summary and F2', () => {
    const a = scoreSentence(S([{ start: 0, end: 5 }]), [{ start: 0, end: 5 }]);
    const b = scoreSentence(S([{ start: 0, end: 5 }]), []);
    const c = scoreSentence(S([]), [{ start: 1, end: 2 }]);
    const sum = summarize([a, b, c]);
    assert.deepEqual(sum, { found: 1, total: 2, falseAlarms: 1, sentences: 3 });
    // P = 1/2, R = 1/2 → F2 = 0.5
    assert.ok(Math.abs(fScore(sum) - 0.5) < 1e-9);
    assert.equal(fScore({ found: 0, total: 3, falseAlarms: 0 }), 0);
    // Recall weighs more: P=1,R=.5 scores below P=.5,R=1.
    assert.ok(fScore({ found: 1, total: 2, falseAlarms: 0 }) < fScore({ found: 2, total: 2, falseAlarms: 2 }));
});
