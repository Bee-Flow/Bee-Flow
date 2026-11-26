// @typecheck
/**
 * whisperBatchWait — the length of the audio decides how long an Azure
 * Whisper batch job may take and what it is asked to do.
 *
 * Run: cd server && node --test core/voice/whisperBatchWait.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { flacDurationSeconds, computeWhisperBatchTimeouts, whisperBatchJobProperties } = require('./whisperBatchWait.mts');

/**
 * The first 26 bytes of a FLAC file: the marker, the STREAMINFO block header
 * and STREAMINFO up to the total number of samples.
 * @param {number} sampleRate
 * @param {number} totalSamples
 */
function flacHeader(sampleRate, totalSamples) {
    const b = Buffer.alloc(42);
    b.write('fLaC', 0, 'latin1');
    b[4] = 0x00;                   // STREAMINFO, not the last block
    b.writeUIntBE(34, 5, 3);       // block length
    b.writeUInt16BE(4096, 8);      // min block size
    b.writeUInt16BE(4096, 10);     // max block size
    // 20 bits sample rate, 3 bits channels-1 (mono = 0), 5 bits bits-per-sample-1 (16 bit = 15), 36 bits total samples
    b[18] = (sampleRate >> 12) & 0xff;
    b[19] = (sampleRate >> 4) & 0xff;
    b[20] = ((sampleRate & 0x0f) << 4) | (0 << 1) | (15 >> 4);
    b[21] = ((15 & 0x0f) << 4) | Math.floor(totalSamples / 2 ** 32);
    b.writeUInt32BE(totalSamples % 2 ** 32, 22);
    return b;
}

test('the length of a FLAC file is read from its header', () => {
    assert.strictEqual(flacDurationSeconds(flacHeader(16000, 16000 * 305)), 305);
    // Five hours at 16 kHz, and a count past 32 bits (48 kHz for 30 hours).
    assert.strictEqual(flacDurationSeconds(flacHeader(16000, 16000 * 18000)), 18000);
    assert.strictEqual(flacDurationSeconds(flacHeader(48000, 48000 * 108000)), 108000);
});

test('a file that is no FLAC, a cut-off header or a header without a sample count has no length', () => {
    assert.strictEqual(flacDurationSeconds(Buffer.from('AUDIO-OF-USER-A')), null);
    assert.strictEqual(flacDurationSeconds(flacHeader(16000, 16000).subarray(0, 20)), null);
    assert.strictEqual(flacDurationSeconds(flacHeader(16000, 0)), null);
    assert.strictEqual(flacDurationSeconds(/** @type {any} */ (null)), null);
});

test('the measured length wins over the size: a quiet three-hour meeting is not a short one', () => {
    // Three hours that FLAC squeezed into the size of twenty minutes.
    const quiet = computeWhisperBatchTimeouts({ bytes: 1200 * 16000, ext: '.flac', durationSeconds: 3 * 3600, env: {} });
    assert.strictEqual(quiet.estimatedSeconds, 3 * 3600);
    assert.strictEqual(quiet.pollCapMs, (30 + 180) * 60_000);
    // Without a measured length the size is the estimate.
    const bySize = computeWhisperBatchTimeouts({ bytes: 1200 * 16000, ext: '.flac', durationSeconds: null, env: {} });
    assert.strictEqual(bySize.estimatedSeconds, 1200);
});

test('up to 240 minutes the job asks for a speaker range; a longer file gets two-voice separation, not a refused job', () => {
    const fourHours = whisperBatchJobProperties({ durationSeconds: 240 * 60, jobTimeToLive: 'PT6H' });
    assert.deepStrictEqual(fourHours.diarization, { speakers: { minCount: 1, maxCount: 35 } });
    assert.strictEqual(fourHours.timeToLive, 'PT6H');

    const exact = whisperBatchJobProperties({ numSpeakers: 4, durationSeconds: 7200, jobTimeToLive: 'PT4H' });
    assert.deepStrictEqual(exact.diarization, { speakers: { minCount: 4, maxCount: 4 } });

    const fiveHours = whisperBatchJobProperties({ numSpeakers: 4, durationSeconds: 5 * 3600, jobTimeToLive: 'PT7H' });
    assert.strictEqual('diarization' in fiveHours, false);
    assert.strictEqual(fiveHours.diarizationEnabled, true);

    // An unknown length is treated as within the limit.
    assert.ok(whisperBatchJobProperties({ durationSeconds: null, jobTimeToLive: 'PT4H' }).diarization);
});
