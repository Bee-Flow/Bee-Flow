const test = require('node:test');
const assert = require('node:assert');

const { normalizeWords, wer, speakerStats } = require('./metrics');

test('normalizeWords strips punctuation and casing but keeps diacritics', () => {
    assert.deepStrictEqual(
        normalizeWords('Hallo, wereld! Hoe gaat het?'),
        ['hallo', 'wereld', 'hoe', 'gaat', 'het'],
    );
    // "één" vs "een" is a real Dutch distinction — normalization must not erase it.
    assert.deepStrictEqual(normalizeWords('één'), ['één']);
    assert.notDeepStrictEqual(normalizeWords('één'), normalizeWords('een'));
});

test('normalizeWords handles typographic quotes and empty input', () => {
    assert.deepStrictEqual(normalizeWords('“Ja” … (dus)'), ['ja', 'dus']);
    assert.deepStrictEqual(normalizeWords(''), []);
    assert.deepStrictEqual(normalizeWords(null), []);
});

test('wer is zero for an exact match, ignoring punctuation and case', () => {
    const r = wer('de vergadering begint om tien uur', 'De vergadering begint, om tien uur.');
    assert.strictEqual(r.wer, 0);
    assert.strictEqual(r.substitutions, 0);
    assert.strictEqual(r.deletions, 0);
    assert.strictEqual(r.insertions, 0);
});

test('wer counts a substitution', () => {
    const r = wer('de vergadering begint om tien uur', 'de vergadering begint om negen uur');
    assert.strictEqual(r.substitutions, 1);
    assert.strictEqual(r.deletions, 0);
    assert.strictEqual(r.insertions, 0);
    assert.strictEqual(r.refWords, 6);
    assert.ok(Math.abs(r.wer - 1 / 6) < 1e-9);
});

test('wer counts a deletion', () => {
    const r = wer('een twee drie vier', 'een twee vier');
    assert.strictEqual(r.deletions, 1);
    assert.strictEqual(r.substitutions, 0);
    assert.strictEqual(r.insertions, 0);
    assert.strictEqual(r.wer, 0.25);
});

test('wer counts an insertion', () => {
    const r = wer('een twee drie', 'een twee en drie');
    assert.strictEqual(r.insertions, 1);
    assert.strictEqual(r.substitutions, 0);
    assert.strictEqual(r.deletions, 0);
    assert.ok(Math.abs(r.wer - 1 / 3) < 1e-9);
});

test('wer can exceed 1.0 when the model over-produces', () => {
    const r = wer('ja', 'ja ja ja ja ja');
    assert.ok(r.wer > 1);
    assert.strictEqual(r.insertions, 4);
});

test('wer reports insertions rather than dividing by zero on an empty reference', () => {
    assert.strictEqual(wer('', '').wer, 0);
    const r = wer('', 'iets');
    assert.strictEqual(r.wer, Infinity);
    assert.strictEqual(r.insertions, 1);
});

test('wer scores a total miss as 1.0', () => {
    const r = wer('een twee drie', '');
    assert.strictEqual(r.wer, 1);
    assert.strictEqual(r.deletions, 3);
});

test('speakerStats counts distinct speakers and turns, not segments', () => {
    const s = speakerStats([
        { speakerId: 'speaker_0', start: 0, end: 2, text: 'hoi' },
        { speakerId: 'speaker_0', start: 2, end: 4, text: 'alles goed' },
        { speakerId: 'speaker_1', start: 4, end: 6, text: 'ja prima' },
        { speakerId: 'speaker_0', start: 6, end: 7, text: 'mooi' },
    ]);
    assert.strictEqual(s.speakerCount, 2);
    assert.strictEqual(s.turns, 3); // 0 → 1 → 0, consecutive same-speaker collapses
    assert.strictEqual(s.segments, 4);
    assert.strictEqual(s.durations.speaker_0, 5);
    assert.strictEqual(s.durations.speaker_1, 2);
});

test('speakerStats detects diarization collapse to a single speaker', () => {
    const s = speakerStats([
        { speakerId: 'speaker_0', start: 0, end: 5, text: 'a' },
        { speakerId: 'speaker_0', start: 5, end: 9, text: 'b' },
    ]);
    assert.strictEqual(s.speakerCount, 1);
    assert.strictEqual(s.turns, 1);
});

test('speakerStats tolerates missing speaker ids and empty input', () => {
    const s = speakerStats([{ start: 0, end: 1, text: 'x' }]);
    assert.strictEqual(s.speakerCount, 1);
    assert.deepStrictEqual(speakerStats([]), {
        speakerCount: 0, turns: 0, segments: 0, durations: {},
    });
    assert.strictEqual(speakerStats(null).speakerCount, 0);
});
