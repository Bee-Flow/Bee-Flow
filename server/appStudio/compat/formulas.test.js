'use strict';

/**
 * Compat corpus: the expression engine still reads every formula of every stored app, and every
 * expression of its own golden corpus, exactly as it did before the collection functions, `??`,
 * list and object literals and author functions were added.
 *
 * formulaBaseline.json holds, for every text the engine could parse back then, a fingerprint of
 * the parsed tree and of its value (formulaBaseline.mts says how it was written). Green means
 * each of those parses to the same tree and gives the same value today, so everything that was
 * added could only be written in a formula that was an error before.
 *
 * Run: cd server && node --test appStudio/compat/formulas.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const engine = require('../../shared/expr/index.mjs');
const { CASES } = require('../../shared/expr/corpus.mjs');
const { BASELINE_FILE, candidates, fingerprint, keyOf } = require('./formulaBaseline.mts');

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
const all = candidates(CASES);

test('the baseline covers the corpus: every fingerprint belongs to a text that is still there', () => {
    const present = new Set(all.map(keyOf));
    const gone = Object.keys(baseline.entries).filter((k) => !present.has(k));
    assert.deepEqual(gone, [], 'a corpus text or golden case the baseline was written from is gone');
    assert.equal(Object.keys(baseline.entries).length, baseline.about.parsed);
    assert.ok(baseline.about.parsed > 2000, 'sanity: the baseline holds the formulas of the corpus');
});

test('every text the engine could parse before parses to the same tree and gives the same value', () => {
    const moved = [];
    for (const expr of all) {
        const before = baseline.entries[keyOf(expr)];
        if (before === undefined) continue; // rejected before, or added after the baseline
        if (fingerprint(engine, expr) !== before) moved.push(expr);
    }
    assert.deepEqual(moved, [], 'a formula that was valid before now parses or evaluates differently');
});

test('the additions were errors before: none of them is in the baseline', () => {
    const added = ['sort(a)', 'reverse(a)', 'slice(a, 1)', 'groupBy(a, "k")', 'reduce(a, acc + it, 0)', 'keys(a)', 'values(a)',
        'merge(a, b)', 'range(3)', '[1, 2]', '[]', '{ a: 1 }', '{}', 'a ?? b', 'a ? [1] : b'];
    for (const expr of added) {
        assert.doesNotThrow(() => engine.parseExpr(expr), `parses today: ${expr}`);
        assert.equal(baseline.entries[keyOf(expr)], undefined, `was not valid before: ${expr}`);
    }
});
