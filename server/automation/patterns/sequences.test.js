// @typecheck
'use strict';
/**
 * Run: node --test automation/patterns/sequences.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { sessionize, mineSequences, isSubsequence } = require('./sequences');
const { rng } = require('./__fixtures__/builders');

const DAY = 86_400_000;
const MIN = 60_000;
const T0 = Date.UTC(2026, 6, 1, 9);
/** @returns {any} */
const ev = (/** @type {number} */ ts, /** @type {string} */ verb, /** @type {string|null} */ sessionKey = null, app = verb.split('_')[0]) => ({ ts, verb, app, sessionKey, source: 'ledger', objectType: 'tool' });

test('sessionize groups by key and splits on long pauses', () => {
    const s = sessionize([
        ev(T0, 'a_x', 'c1'), ev(T0 + 5 * MIN, 'b_y', 'c1'), ev(T0 + 5 * 60 * MIN, 'a_x', 'c1'),
        ev(T0, 'z_q'), ev(T0 + 10 * MIN, 'z_r'), ev(T0 + 90 * MIN, 'z_s'),
    ]);
    assert.deepStrictEqual(s.map((x) => x.events.map((e) => e.verb)), [['a_x', 'b_y'], ['z_q', 'z_r'], ['z_s'], ['a_x']]);
});

test('mineSequences finds the repeated ordered run with its support and days', () => {
    const sessions = [];
    for (let d = 0; d < 6; d++) {
        const t = T0 + d * DAY;
        sessions.push({ key: `s${d}`, start: t, end: t, events: [ev(t, 'gmail_search'), ev(t + MIN, 'gmail_search'), ev(t + 2 * MIN, 'noise_' + d), ev(t + 4 * MIN, 'sheets_append')] });
    }
    const out = mineSequences(sessions, { minSupport: 4, minDays: 3 });
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].verbs, ['gmail_search', 'sheets_append']);
    assert.deepStrictEqual(out[0].apps, ['gmail', 'sheets']);
    assert.strictEqual(out[0].support, 6);
    assert.strictEqual(out[0].distinctDays, 6);
    assert.deepStrictEqual(out[0].spansMs, Array(6).fill(4 * MIN));
});

test('mineSequences keeps closed patterns only', () => {
    const sessions = [];
    for (let d = 0; d < 5; d++) {
        const t = T0 + d * DAY;
        sessions.push({ key: `s${d}`, start: t, end: t, events: [ev(t, 'a_1'), ev(t + MIN, 'b_2'), ev(t + 2 * MIN, 'c_3')] });
    }
    const out = mineSequences(sessions, { minSupport: 4, minDays: 3 });
    assert.deepStrictEqual(out.map((p) => p.verbs), [['a_1', 'b_2', 'c_3']]);
});

test('mineSequences respects minDays and minSupport', () => {
    const same = [0, 1, 2, 3, 4].map((i) => {
        const t = T0 + i * MIN * 30;
        return { key: `s${i}`, start: t, end: t, events: [ev(t, 'a_1'), ev(t + MIN, 'b_2')] };
    });
    assert.strictEqual(mineSequences(same, { minSupport: 4, minDays: 3 }).length, 0);
    assert.strictEqual(mineSequences(same.slice(0, 3), { minSupport: 4, minDays: 1 }).length, 0);
    assert.strictEqual(mineSequences(same, { minSupport: 4, minDays: 1 }).length, 1);
});

/** Sessions of random tools from a vocabulary, each with `len` steps, one per day-slot. */
function randomSessions(seed, { count, vocab, len, plant = null, plantEvery = 2 }) {
    const r = rng(seed);
    const out = [];
    for (let i = 0; i < count; i++) {
        const t = T0 + Math.floor(i / 20) * DAY + (i % 20) * 20 * MIN;
        const verbs = Array.from({ length: len }, () => vocab[Math.floor(r() * vocab.length)]);
        if (plant && i % plantEvery === 0) verbs.splice(2, 0, ...plant);
        out.push({ key: `r${i}`, start: t, end: t, events: verbs.map((v, k) => ev(t + k * MIN, v)) });
    }
    return out;
}
const VOCAB = Array.from({ length: 15 }, (_, i) => `app${i % 5}_verb_${i}`);

test('random tool use in long sessions is not a habit', () => {
    assert.deepStrictEqual(mineSequences(randomSessions(1, { count: 600, vocab: VOCAB, len: 8 })), []);
});

test('a habit hidden in long random sessions is found once, without random hangers-on', () => {
    const out = mineSequences(randomSessions(2, { count: 600, vocab: VOCAB, len: 8, plant: ['zz_list', 'zz_update', 'zz_note'], plantEvery: 10 }));
    assert.deepStrictEqual(out.map((p) => p.verbs), [['zz_list', 'zz_update', 'zz_note']]);
    assert.strictEqual(out[0].support, 60);
});

test('someone who does little else than triage still has a triage habit', () => {
    const sessions = [];
    for (let d = 0; d < 20; d++) {
        const t = T0 + d * DAY;
        const verbs = d % 10 === 9 ? ['zz_list'] : ['zz_list', 'zz_update', 'zz_note'];
        sessions.push({ key: `t${d}`, start: t, end: t, events: verbs.map((v, k) => ev(t + k * MIN, v)) });
    }
    assert.deepStrictEqual(mineSequences(sessions).map((p) => p.verbs), [['zz_list', 'zz_update', 'zz_note']]);
});

test('steps further apart than maxGap do not form a pattern', () => {
    const sessions = [];
    for (let d = 0; d < 6; d++) {
        const t = T0 + d * DAY;
        const verbs = ['a_1', 'x_1', 'x_2', 'x_3', 'x_4', 'b_2'].map((v) => (v.startsWith('x') ? `${v}_${d}` : v));
        sessions.push({ key: `g${d}`, start: t, end: t, events: verbs.map((v, k) => ev(t + k * MIN, v)) });
    }
    assert.deepStrictEqual(mineSequences(sessions, { maxGap: 3 }), []);
    assert.deepStrictEqual(mineSequences(sessions, { maxGap: 4 }).map((p) => p.verbs), [['a_1', 'b_2']]);
});

test('isSubsequence', () => {
    assert.strictEqual(isSubsequence(['a', 'c'], ['a', 'b', 'c']), true);
    assert.strictEqual(isSubsequence(['c', 'a'], ['a', 'b', 'c']), false);
});
