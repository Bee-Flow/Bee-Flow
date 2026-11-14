/**
 * buildTranscriptOrThrow: what counts as "no transcription happened".
 *
 * Run: cd server && node --test usecases/transcriptions/speakerNaming.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildTranscriptOrThrow } = require('./speakerNaming');

test('no segments at all fails the note', () => {
    assert.throws(() => buildTranscriptOrThrow({ text: '', segments: [] }), /no segments/);
    // The engine answered nothing: an upstream failure, its sentence written for the note's readers.
    assert.throws(() => buildTranscriptOrThrow({ text: '', segments: [] }), { status: 502, code: 'transcription_empty', expose: true });
});

test('speaker turns without a single word fail the note instead of completing it empty', () => {
    // A diarization-only result: pyannote maps it to rows with empty text.
    const response = {
        text: '',
        segments: [
            { speakerId: 'SPEAKER_00', start: 0, end: 12, text: '' },
            { speakerId: 'SPEAKER_01', start: 12.5, end: 30, text: '   ' },
        ],
    };
    assert.throws(() => buildTranscriptOrThrow(response), /no words/);
    // Nothing to hear in the recording the user sent: a 422, not a server fault.
    assert.throws(() => buildTranscriptOrThrow(response), { status: 422, code: 'transcription_no_words' });
});

test('one segment with words is a transcript', () => {
    const built = buildTranscriptOrThrow({
        text: 'hallo',
        segments: [
            { speakerId: 'SPEAKER_00', start: 0, end: 4, text: '' },
            { speakerId: 'SPEAKER_01', start: 4, end: 8, text: 'hallo' },
        ],
    });
    assert.ok(built.merged.length >= 1);
    assert.match(built.transcript, /hallo/);
});
