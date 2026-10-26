// @typecheck strict
/**
 * The shared tail of every chat-tool transcription provider. The provider
 * wiring (what each handler hands in) is pinned end to end in
 * integrations/transcriptionTools.test.js; this file pins the pieces.
 *
 * Run: cd server && node --test integrations/transcription/finalize.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const fin = require('./finalize');

const SEGS = [
    { speakerId: 'S1', start: 0, end: 4.5, text: ' hello ' },
    { speakerId: 'S1', start: 4.5, end: 9, text: 'there' },
    { speakerId: 'S2', start: 9, end: 70, text: 'long answer' },
    { speakerId: 'S1', start: 70, end: 3700, text: 'bye' },
];
const LINES = [
    '[S1] 00:00 - 00:09: hello there',
    '[S2] 00:09 - 01:10: long answer',
    '[S1] 01:10 - 01:01:40: bye',
];

test('formatTime: mm:ss, hh:mm:ss past an hour, 00:00 for nullish', () => {
    assert.strictEqual(fin.formatTime(null), '00:00');
    assert.strictEqual(fin.formatTime(undefined), '00:00');
    assert.strictEqual(fin.formatTime(65.9), '01:05');
    assert.strictEqual(fin.formatTime(3661), '01:01:01');
});

test('mergeSegments joins consecutive turns of one speaker and trims text', () => {
    assert.deepStrictEqual(fin.mergeSegments([]), []);
    assert.deepStrictEqual(fin.mergeSegments(null), []);
    assert.deepStrictEqual(fin.mergeSegments([{ start: 1, end: 2, text: ' a ' }]), [{ speakerId: 'Unknown', start: 1, end: 2, text: 'a' }]);
    assert.deepStrictEqual(fin.mergeSegments(SEGS), [
        { speakerId: 'S1', start: 0, end: 9, text: 'hello there' },
        { speakerId: 'S2', start: 9, end: 70, text: 'long answer' },
        { speakerId: 'S1', start: 70, end: 3700, text: 'bye' },
    ]);
});

test('speaker map, transcript lines and max segment end', () => {
    const merged = fin.mergeSegments(SEGS);
    assert.deepStrictEqual(fin.buildSpeakerMap(merged), { S1: { duration: 3639, segments: 2 }, S2: { duration: 61, segments: 1 } });
    assert.deepStrictEqual(fin.formatTranscriptLines(merged), LINES);
    assert.strictEqual(fin.maxSegmentEnd([]), 0);
    assert.strictEqual(fin.maxSegmentEnd(SEGS), 3700);
});

test('finalizeTranscript: names come from the unrenamed lines and are applied to the result', async () => {
    /** @type {unknown[]} */
    const seen = [];
    const res = await fin.finalizeTranscript({
        segments: SEGS.map(s => ({ ...s })),
        audioFileName: 'a.mp3',
        language: 'en',
        totalDuration: 3700.4,
        identifyNames: (ids, lines) => { seen.push([ids, lines]); return { S2: 'Ann' }; },
    });
    assert.deepStrictEqual(seen, [[['S1', 'S2'], LINES]]);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.fileName, 'a.mp3');
    assert.strictEqual(res.language, 'en');
    assert.strictEqual(res.duration, '01:01:40');
    assert.strictEqual(res.durationSeconds, 3700);
    assert.strictEqual(res.speakerCount, 2);
    assert.strictEqual(res.segmentCount, 3);
    assert.deepStrictEqual(res.speakers, [
        { id: 'S1', speakingTime: '01:00:39', segments: 2 },
        { id: 'Ann', speakingTime: '01:01', segments: 1 },
    ]);
    assert.strictEqual(res.transcript, LINES.join('\n').replace('[S2]', '[Ann]'));
    assert.deepStrictEqual(res.segments[1], { speaker: 'Ann', start: 9, end: 70, startFormatted: '00:09', endFormatted: '01:10', text: 'long answer' });
});

test('finalizeTranscript: a null name mapping keeps the speaker ids', async () => {
    const res = await fin.finalizeTranscript({
        segments: SEGS.map(s => ({ ...s })), audioFileName: 'a.mp3', language: 'nl', totalDuration: 0,
        identifyNames: async () => null,
    });
    assert.deepStrictEqual(res.speakers.map(s => s.id), ['S1', 'S2']);
    assert.strictEqual(res.duration, '00:00');
});
