'use strict';
/**
 * The bench's use of the engine: the draft is normalised by the engine, words
 * and patterns go through compileTypes/matchNode, ai goes through probeGuard
 * together with the org's other ai prompts, floors and the overlap decode are
 * applied locally, and the guard's absence is a 503.
 *
 * Run: node --test core/privacy/customData/bench.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { HttpError } = require('../../http/errors');
const {
    normaliseDraft, runTest, probeAll, decodeAi, placeholderText, otherAiTypes, PROBE_BATCH,
} = require('./bench');
const { createFakeEngine, scriptedProbe } = require('./fakeEngine.testutil');

const ID = 'cdt_0123456789';
const WORDS = { id: ID, name: 'Projects', method: 'words', tokenKey: 'project', words: { values: ['Falcon'], caseSensitive: false, wholeWord: true } };
const AI = { id: ID, name: 'Projects', method: 'ai', tokenKey: 'project', ai: { prompt: 'project code name', floor: 0.5 } };

test('normaliseDraft keeps only the own method block and passes the org\'s types', async () => {
    const engine = createFakeEngine();
    const orgTypes = [{ id: 'cdt_aaaaaaaaaa', method: 'words' }];
    const spec = await normaliseDraft(engine, { ...WORDS, pattern: { source: 'x' }, quality: { found: 1 }, status: 'invalid' }, { orgId: 'o1', orgTypes });
    assert.equal(spec.pattern, undefined);
    assert.equal(spec.quality, undefined);
    assert.equal(spec.status, undefined, 'status would stop the engine from compiling it');
    assert.deepEqual(engine.calls.validate[0].opts, { orgId: 'o1', existingTypes: orgTypes });
});

test('normaliseDraft borrows a neutral identity when only identity fields are wrong', async () => {
    const engine = createFakeEngine();
    const spec = await normaliseDraft(engine, { ...WORDS, tokenKey: 'data' }, { orgId: 'o1', orgTypes: [] });
    assert.equal(spec.tokenKey, 'bench_test');
    assert.deepEqual(spec.words, WORDS.words);
});

test('normaliseDraft: an unsafe pattern is 422 pattern_unsafe with the reason', async () => {
    const engine = createFakeEngine();
    await assert.rejects(
        normaliseDraft(engine, { id: ID, name: 'X', method: 'pattern', tokenKey: 'x', pattern: { source: 'KL(?=-)' } }, { orgId: 'o1', orgTypes: [] }),
        (err) => err.status === 422 && err.code === 'pattern_unsafe' && err.details.reason === 're2_unsupported',
    );
    await assert.rejects(
        normaliseDraft(engine, { id: ID, name: 'X', method: 'ai', tokenKey: 'x', ai: { prompt: 'x', floor: 0.5 } }, { orgId: 'o1', orgTypes: [] }),
        (err) => err.status === 400 && err.code === 'invalid_request',
    );
});

test('words: the production matcher scores the sentences, no guard involved', async () => {
    const engine = createFakeEngine({ probe: () => { throw new Error('guard must not be called'); } });
    const spec = await normaliseDraft(engine, WORDS, { orgId: 'o1', orgTypes: [] });
    const out = await runTest({
        engine,
        spec,
        sentences: [
            { id: 'a', text: 'Falcon moved to falcon-2.', gold: [{ start: 0, end: 6 }] },
            { id: 'b', text: 'Falconry is a hobby.', gold: [] },
            { id: 'c', text: 'Nothing about it.', gold: [{ start: 0, end: 7 }] },
        ],
        orgTypes: [],
    });
    assert.equal(out.engine, 'local');
    assert.equal(engine.calls.probe.length, 0);
    assert.deepEqual(out.results[0].marks, [{ start: 0, end: 6, kind: 'hit' }, { start: 16, end: 22, kind: 'false_alarm' }]);
    assert.equal(out.results[0].verdict, 'false_alarm');
    assert.equal(out.results[1].verdict, 'correct');
    assert.equal(out.results[2].verdict, 'missed');
    assert.deepEqual(out.summary, { found: 1, total: 2, falseAlarms: 1, sentences: 3 });
    assert.equal(out.preview, undefined, 'a preview only for exactly one sentence');
});

test('one sentence: marks as found, and the text as the AI would see it', async () => {
    const engine = createFakeEngine();
    const spec = await normaliseDraft(engine, WORDS, { orgId: 'o1', orgTypes: [] });
    const out = await runTest({ engine, spec, sentences: [{ id: 'a', text: 'Falcon and FALCON and Falcon.' }], orgTypes: [], tokenKey: 'project' });
    assert.equal(out.results[0].verdict, 'no_gold');
    assert.ok(out.results[0].marks.every((m) => m.kind === 'found'));
    assert.equal(out.preview, '[project_1] and [project_2] and [project_1].');
});

test('ai: one probe per batch of 8, with the org\'s other ai prompts, floors applied here', async () => {
    const probe = scriptedProbe([
        { prompt: 'project code name', word: 'Falcon', score: 0.8 },
        { prompt: 'project code name', word: 'Heron', score: 0.3 },
        // The other type claims "Osprey" more strongly than ours.
        { prompt: 'project code name', word: 'Osprey', score: 0.6 },
        { prompt: 'bird name', word: 'Osprey', score: 0.9 },
    ]);
    const engine = createFakeEngine({ probe });
    const orgTypes = [
        { id: 'cdt_bbbbbbbbbb', method: 'ai', ai: { prompt: 'bird name', floor: 0.4 } },
        { id: ID, method: 'ai', ai: { prompt: 'old wording', floor: 0.5 } },
        { id: 'cdt_cccccccccc', method: 'ai', status: 'invalid', ai: { prompt: 'broken', floor: 0.5 } },
    ];
    const spec = await normaliseDraft(engine, AI, { orgId: 'o1', orgTypes });
    const sentences = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, text: `Falcon, Heron and Osprey ${i}`, gold: [{ start: 0, end: 6 }, { start: 8, end: 13 }] }));
    const out = await runTest({ engine, spec, sentences, orgTypes });
    assert.equal(out.engine, 'guard');
    assert.equal(engine.calls.probe.length, 2);
    assert.equal(engine.calls.probe[0].texts.length, PROBE_BATCH);
    assert.equal(engine.calls.probe[1].texts.length, 2);
    assert.deepEqual(engine.calls.probe[0].labelSet, { [ID]: 'project code name', cdt_bbbbbbbbbb: 'bird name' });
    assert.deepEqual(engine.calls.probe[0].opts, { priority: 'bulk' });
    // Falcon found, Heron under the floor, Osprey won by the other label.
    assert.deepEqual(out.results[9].marks, [{ start: 0, end: 6, kind: 'hit' }, { start: 8, end: 13, kind: 'missed' }]);
    assert.deepEqual(out.summary, { found: 10, total: 20, falseAlarms: 0, sentences: 10 });
});

test('the guard missing is a 503 guard_unavailable; the engine\'s own HttpError passes through', async () => {
    const broken = { probeGuard: async () => { throw new Error('ECONNREFUSED'); } };
    await assert.rejects(probeAll(broken, ['a'], { [ID]: 'x' }), (err) => err.status === 503 && err.code === 'guard_unavailable');
    const old = { probeGuard: async () => { throw new HttpError(503, 'guard_unavailable', 'Guard too old'); } };
    await assert.rejects(probeAll(old, ['a'], { [ID]: 'x' }), (err) => err.message === 'Guard too old');
});

test('probe candidates out of range are ignored', async () => {
    const engine = { probeGuard: async () => ({ candidates: [
        { text_idx: 5, label: ID, start: 0, end: 1, score: 1 },
        { text_idx: 0, label: ID, start: 3, end: 2, score: 1 },
        { text_idx: 0, label: ID, start: 0, end: 2, score: 0.9 },
    ] }) };
    assert.deepEqual(await probeAll(engine, ['abc'], { [ID]: 'x' }), [{ textIdx: 0, label: ID, start: 0, end: 2, score: 0.9 }]);
});

test('decode: floors per label, highest score wins an overlap', () => {
    const cands = [
        { textIdx: 0, label: ID, start: 0, end: 5, score: 0.6 },
        { textIdx: 0, label: 'cdt_bbbbbbbbbb', start: 3, end: 8, score: 0.7 },
        { textIdx: 0, label: ID, start: 10, end: 12, score: 0.45 },
        { textIdx: 1, label: ID, start: 0, end: 2, score: 0.5 },
    ];
    assert.deepEqual(decodeAi(cands, { [ID]: 0.4, cdt_bbbbbbbbbb: 0.5 }, ID, 2), [[{ start: 10, end: 12 }], [{ start: 0, end: 2 }]]);
    assert.deepEqual(decodeAi(cands, { [ID]: 0.4, cdt_bbbbbbbbbb: 0.9 }, ID, 2), [[{ start: 0, end: 5 }, { start: 10, end: 12 }], [{ start: 0, end: 2 }]]);
});

test('the ai group holds at most 6 labels and never the same prompt twice', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `cdt_${String(i).padStart(10, 'a')}`, method: 'ai', ai: { prompt: `label ${i}`, floor: 0.5 } }));
    assert.equal(otherAiTypes(many, ID, 'x').length, 5);
    assert.deepEqual(otherAiTypes(many, ID, 'LABEL 0').map((t) => t.prompt).includes('label 0'), false);
});

test('placeholders fall back to a safe key', () => {
    assert.equal(placeholderText('a b', [{ start: 0, end: 1 }], 'Bad Key!'), '[data_1] b');
});
