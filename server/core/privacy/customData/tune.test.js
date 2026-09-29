'use strict';
/**
 * Tuning: the ranking and its tie-breaks, the ≥5-gold rule, and one run per
 * method against a fake engine (words flags, pattern candidates, ai wordings
 * with a local floor sweep and one probe per wording).
 *
 * Run: node --test core/privacy/customData/tune.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    compareCandidates, rankCandidates, isImprovement, sensitivityFor, tuneType, assertEnoughGold, FLOOR_SWEEP,
} = require('./tune');
const { localPatternCheck } = require('./patternTools');
const { createFakeEngine, scriptedProbe } = require('./fakeEngine.testutil');

const ID = 'cdt_0123456789';
const sum = (found, total, falseAlarms) => ({ found, total, falseAlarms, sentences: 5 });
const c = (s, extra = {}) => ({ summary: s, order: 0, length: 0, ...extra });
const validatePattern = async (src, cs) => localPatternCheck(src, cs);

test('ranking: F2 first, recall weighted', () => {
    const recall = c(sum(5, 5, 3), { order: 1 });
    const precise = c(sum(3, 5, 0), { order: 0 });
    assert.deepEqual(rankCandidates([precise, recall])[0], recall);
});

test('ties: fewer false alarms, then the higher floor, then the shorter label, then the order tried', () => {
    const base = sum(4, 5, 1);
    assert.equal(compareCandidates(c(sum(4, 5, 1)), c(sum(4, 5, 1))), 0);
    const a = c(base, { floor: 0.5, order: 1 });
    const b = c(base, { floor: 0.7, order: 2 });
    assert.equal(rankCandidates([a, b])[0], b, 'higher floor');
    const short = c(base, { floor: 0.7, length: 5, order: 3 });
    const long = c(base, { floor: 0.7, length: 20, order: 0 });
    assert.equal(rankCandidates([long, short])[0], short, 'shorter label');
    const first = c(base, { floor: 0.7, length: 5, order: 0 });
    const later = c(base, { floor: 0.7, length: 5, order: 9 });
    assert.equal(rankCandidates([later, first])[0], first, 'order tried');
});

test('ties on F2 go to fewer false alarms', () => {
    // Both F2 = 0 (nothing found), different false alarms.
    const noisy = c(sum(0, 5, 3), { order: 0 });
    const quiet = c(sum(0, 5, 1), { order: 1 });
    assert.equal(rankCandidates([noisy, quiet])[0], quiet);
    assert.equal(isImprovement(quiet, noisy), true);
    assert.equal(isImprovement(noisy, noisy), false);
});

test('sensitivity words for a floor', () => {
    assert.equal(sensitivityFor(0.7), 'low');
    assert.equal(sensitivityFor(0.45), 'medium');
    assert.equal(sensitivityFor(0.44), 'high');
    assert.equal(FLOOR_SWEEP.length, 15);
    assert.equal(FLOOR_SWEEP[0], 0.2);
    assert.equal(FLOOR_SWEEP[14], 0.9);
});

test('fewer than 5 sentences with a marked part is 400 tune_needs_gold', () => {
    const sentences = [
        ...Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, text: 'x', gold: [{ start: 0, end: 1 }] })),
        { id: 'n', text: 'x', gold: [] },
        { id: 'o', text: 'x' },
    ];
    assert.throws(() => assertEnoughGold(sentences), (err) => err.status === 400 && err.code === 'tune_needs_gold' && err.details.have === 4);
});

// ── One run per method ─────────────────────────────────────────────────────

const goldAt = (text, word) => [{ start: text.indexOf(word), end: text.indexOf(word) + word.length }];
const sentencesFor = (words, nearMisses = []) => [
    ...words.map((w, i) => {
        const text = `Please check ${w} before friday ${i}.`;
        return { id: `s${i}`, text, gold: goldAt(text, w) };
    }),
    ...nearMisses.map((t, i) => ({ id: `n${i}`, text: t, gold: [] })),
];

test('words: finds the flags that catch every spelling', async () => {
    const engine = createFakeEngine();
    const spec = { id: ID, name: 'P', method: 'words', tokenKey: 'p', words: { values: ['Falcon'], caseSensitive: true, wholeWord: true } };
    const sentences = sentencesFor(['Falcon', 'FALCON', 'falcon', 'Falcon', 'falcon'], ['Falconry is a hobby.']);
    const out = await tuneType({ engine, spec, sentences, validatePattern });
    assert.equal(out.tried, 4);
    assert.deepEqual(out.before.summary, { found: 2, total: 5, falseAlarms: 0, sentences: 6 });
    assert.deepEqual(out.best.config, { words: { values: ['Falcon'], caseSensitive: false, wholeWord: true } });
    assert.deepEqual(out.best.summary, { found: 5, total: 5, falseAlarms: 0, sentences: 6 });
    assert.deepEqual(out.best.describe, { flags: { caseSensitive: false, wholeWord: true } });
    assert.equal(out.improved, true);
});

test('words: when the current flags are already best, nothing improves', async () => {
    const engine = createFakeEngine();
    const spec = { id: ID, name: 'P', method: 'words', tokenKey: 'p', words: { values: ['Falcon'], caseSensitive: false, wholeWord: true } };
    const out = await tuneType({ engine, spec, sentences: sentencesFor(Array(5).fill('Falcon')), validatePattern });
    assert.equal(out.improved, false);
    assert.deepEqual(out.best.config.words, spec.words, 'a full tie keeps the current setting');
});

test('pattern: inferred and assistant candidates must match every example; the best is kept', async () => {
    const engine = createFakeEngine();
    const spec = { id: ID, name: 'N', method: 'pattern', tokenKey: 'n', pattern: { source: 'KL-\\d{5}', caseSensitive: true, engine: 're2' } };
    const codes = ['KL-12345', 'KL-9981', 'KL-123', 'KL-55555', 'KL-4040'];
    const out = await tuneType({
        engine,
        spec,
        sentences: sentencesFor(codes, ['Ticket KL-A is open.', 'Their ref KL-1234567 is not ours.']),
        examples: ['KL-12345', 'KL-9981', 'KL-123'],
        candidates: { patterns: ['KL-\\d+', '(K+)+', 'XY-\\d{5}', 'KL-\\d{3,5}(?=x)'] },
        validatePattern,
    });
    assert.deepEqual(out.before.summary, { found: 2, total: 5, falseAlarms: 1, sentences: 7 });
    // KL-\d+ and KL-\d{3,5} also find all five but raise a false alarm inside
    // the longer reference; the word-bounded variant does not.
    assert.equal(out.best.config.pattern.source, '\\bKL-\\d{3,5}\\b');
    assert.deepEqual(out.best.summary, { found: 5, total: 5, falseAlarms: 0, sentences: 7 });
    assert.equal(out.best.describe.patternWords, 'KL- followed by 3 to 5 digits');
    assert.equal(out.improved, true);
    // Unsafe or non-matching candidates were never tried; the current one
    // (fails KL-9981) was not a candidate either.
    assert.ok(out.tried >= 2);
});

test('ai: one probe per wording, floors swept locally, ties to the middle of the equal run', async () => {
    const probe = scriptedProbe([
        { prompt: 'project name', word: 'Falcon', score: 0.62 },
        { prompt: 'project name', word: 'Heron', score: 0.35 },
        { prompt: 'internal project code name', word: 'Falcon', score: 0.81 },
        { prompt: 'internal project code name', word: 'Heron', score: 0.77 },
        { prompt: 'internal project code name', word: 'friday', score: 0.3 },
    ]);
    const engine = createFakeEngine({ probe });
    const spec = { id: ID, name: 'Projects', method: 'ai', tokenKey: 'p', ai: { prompt: 'project name', floor: 0.5 } };
    const orgTypes = [{ id: 'cdt_bbbbbbbbbb', method: 'ai', ai: { prompt: 'bird name', floor: 0.4 } }];
    const out = await tuneType({
        engine,
        spec,
        sentences: sentencesFor(['Falcon', 'Heron', 'Falcon', 'Heron', 'Falcon']),
        candidates: { aiLabels: ['internal project code name', 'Project Name', 'bad <label>'] },
        orgTypes,
        validatePattern,
    });
    // Wordings: current, the type name, one new label (the duplicate and the bad one are skipped).
    const prompts = [...new Set(engine.calls.probe.map((p) => p.labelSet[ID]))];
    assert.deepEqual(prompts, ['project name', 'Projects', 'internal project code name']);
    assert.equal(engine.calls.probe.length, 3, 'one probe per wording (5 sentences fit one batch)');
    assert.ok(engine.calls.probe.every((p) => p.labelSet.cdt_bbbbbbbbbb === 'bird name'));
    assert.deepEqual(out.before.summary, { found: 3, total: 5, falseAlarms: 0, sentences: 5 });
    // Every floor from 0.35 to 0.75 finds all five without the 0.30 false
    // alarm; the tie goes to the middle of that run, the floor furthest from
    // both a miss (above 0.77) and the false alarm (at 0.30).
    assert.deepEqual(out.best.config, { ai: { prompt: 'internal project code name', floor: 0.55 } });
    assert.deepEqual(out.best.summary, { found: 5, total: 5, falseAlarms: 0, sentences: 5 });
    assert.deepEqual(out.best.describe, { label: 'internal project code name', sensitivity: 'medium' });
    assert.equal(out.improved, true);
    // The current floor 0.5 is on the sweep grid, so it is not tried twice.
    assert.equal(out.tried, 15 * 3);
});
