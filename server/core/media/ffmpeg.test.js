/**
 * ffmpeg runner and the argument lists of every caller.
 *
 * The audio modules used to build their command with fluent-ffmpeg. The
 * `GOLDEN` lists below are what fluent-ffmpeg 2.1.3 produced (`_getArguments()`)
 * for the same calls, recorded before it was removed; each caller's builder
 * must keep producing exactly that.
 *
 * Run: cd server && node --test core/media/ffmpeg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildAudioArgs, runFfmpeg, extractFfmpegError, createLinesRing, getFfmpegPath,
} = require('./ffmpeg');
const { conditionArgs, repackArgs } = require('../voice/audioPreprocess');
const { _decodeArgs: localDecodeArgs } = require('../voice/localWhisper');
const { _internals: { decodeArgs: npuDecodeArgs } } = require('../voice/npuWhisper');
const { _scalewayTranscodeArgs, _scalewaySplitArgs } = require('../meetingNotes/summaryHelpers');

const SPEECH = ['-i', '/in/a b.webm', '-y', '-ac', '1', '-ar', '16000'];

const GOLDEN = {
    wav: [...SPEECH, '-acodec', 'pcm_s16le', '-filter:a', 'highpass=f=80,loudnorm', '-f', 'wav', '/tmp/o.wav'],
    wavClip: [...SPEECH, '-acodec', 'pcm_s16le', '-filter:a', 'highpass=f=80,loudnorm', '-f', 'wav', '-t', '29.5', '/tmp/o.wav'],
    flac: [...SPEECH, '-acodec', 'flac', '-filter:a', 'highpass=f=80,loudnorm', '-f', 'flac', '/tmp/o.flac'],
    flacClip: [...SPEECH, '-acodec', 'flac', '-filter:a', 'highpass=f=80,loudnorm', '-f', 'flac', '-t', '8', '/tmp/o.flac'],
    repack: ['-i', '/in/a.aac', '-y', '-acodec', 'copy', '-f', 'mp4', '-movflags', '+faststart', '/tmp/o.m4a'],
    f32: ['-i', '/in/a.webm', '-y', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_f32le', '-f', 'f32le', '/tmp/o.f32'],
    npu: ['-i', '/in/a.webm', '-y', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', '/tmp/o.wav'],
    mp3: ['-i', '/in/a.m4a', '-y', '-ac', '1', '-ar', '16000', '-f', 'mp3', '/tmp/o.mp3'],
    split: [
        '-i', '/in/a.m4a', '-y', '-ac', '1', '-ar', '16000',
        '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1',
        '-segment_list', '/tmp/d/list.csv', '-segment_list_type', 'csv',
        '/tmp/d/chunk_%03d.mp3',
    ],
};

test('preprocessForStt arguments match the fluent-ffmpeg chain', () => {
    const wav = { codec: 'pcm_s16le', container: 'wav' };
    const flac = { codec: 'flac', container: 'flac' };
    assert.deepStrictEqual(conditionArgs('/in/a b.webm', '/tmp/o.wav', wav), GOLDEN.wav);
    assert.deepStrictEqual(conditionArgs('/in/a b.webm', '/tmp/o.flac', flac), GOLDEN.flac);
    assert.deepStrictEqual(conditionArgs('/in/a b.webm', '/tmp/o.wav', { ...wav, maxSeconds: 29.5 }), GOLDEN.wavClip);
    assert.deepStrictEqual(conditionArgs('/in/a b.webm', '/tmp/o.flac', { ...flac, maxSeconds: '8' }), GOLDEN.flacClip);
    // Only a positive number clips; everything else must leave the output unclipped.
    for (const maxSeconds of [0, -3, NaN, undefined, null, 'abc']) {
        assert.deepStrictEqual(conditionArgs('/in/a b.webm', '/tmp/o.wav', { ...wav, maxSeconds }), GOLDEN.wav, String(maxSeconds));
    }
});

test('asM4aIfAdts arguments match the fluent-ffmpeg chain', () => {
    assert.deepStrictEqual(repackArgs('/in/a.aac', '/tmp/o.m4a'), GOLDEN.repack);
});

test('local and NPU whisper decode arguments match the fluent-ffmpeg chain', () => {
    assert.deepStrictEqual(localDecodeArgs('/in/a.webm', '/tmp/o.f32'), GOLDEN.f32);
    assert.deepStrictEqual(npuDecodeArgs('/in/a.webm', '/tmp/o.wav'), GOLDEN.npu);
});

test('Scaleway transcode and split arguments match the fluent-ffmpeg chain', () => {
    assert.deepStrictEqual(_scalewayTranscodeArgs('/in/a.m4a', '/tmp/o.mp3'), GOLDEN.mp3);
    assert.deepStrictEqual(_scalewaySplitArgs('/in/a.m4a', '/tmp/d/list.csv', '/tmp/d/chunk_%03d.mp3', 600), GOLDEN.split);
});

test('buildAudioArgs omits what is not asked for', () => {
    assert.deepStrictEqual(buildAudioArgs({ input: 'i', output: 'o' }), ['-i', 'i', '-y', 'o']);
});

// ── stderr handling (same cuts fluent-ffmpeg made) ───────────────────────────

test('extractFfmpegError keeps the lines after the last indented or [bracketed] one', () => {
    const stderr = [
        'ffmpeg version 6.1', '  built with gcc', '[mov @ 0x1] moov atom not found',
        '/in/a.m4a: Invalid data found when processing input', '',
    ].join('\n');
    assert.strictEqual(extractFfmpegError(stderr), '/in/a.m4a: Invalid data found when processing input\n');
    assert.strictEqual(extractFfmpegError('  only chatter\n[x] more'), '');
});

test('the stderr ring splits on \\r and \\n, joins chunks and keeps the last 100 lines', () => {
    const ring = createLinesRing(100);
    ring.append('one\r\ntw');
    ring.append('o\rthree\nfo');
    ring.append('ur');
    assert.strictEqual(ring.get(), 'one\ntwo\nthree\nfour');
    ring.close();
    assert.strictEqual(ring.get(), 'one\ntwo\nthree\nfour');

    const big = createLinesRing(100);
    for (let i = 0; i < 500; i++) big.append(`line ${i}\n`);
    big.close();
    const kept = big.get().split('\n');
    assert.ok(kept.length <= 100, `kept ${kept.length} lines`);
    assert.ok(kept.includes('line 499') && kept.includes('line 420'));
    assert.ok(!kept.includes('line 0') && !kept.includes('line 399'));
});

// ── the real binary ──────────────────────────────────────────────────────────

let haveFfmpeg = true;
try { getFfmpegPath(); } catch (_) { haveFfmpeg = false; }
const skip = !haveFfmpeg && 'ffmpeg unavailable';

const made = [];
function tmp(ext) {
    const p = path.join(os.tmpdir(), `ffmpeg-test-${process.pid}-${made.length}${ext}`);
    made.push(p);
    return p;
}
test.after(() => { for (const p of made) { try { fs.unlinkSync(p); } catch (_) {} } });

test('runFfmpeg converts audio', { skip }, async () => {
    const out = tmp('.wav');
    const res = await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=200:duration=1', '-y', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', out]);
    assert.strictEqual(typeof res.stderr, 'string');
    // 1 s of 16 kHz mono s16le is 32000 bytes, plus the WAV header chunks.
    const size = fs.statSync(out).size;
    assert.ok(size > 32000 && size < 32200, `unexpected size ${size}`);
});

test('runFfmpeg rejects with the exit code and ffmpeg\'s own error line', { skip }, async () => {
    const src = tmp('.webm');
    fs.writeFileSync(src, 'not audio at all');
    await assert.rejects(
        runFfmpeg(buildAudioArgs({ input: src, output: tmp('.wav'), format: 'wav' })),
        (err) => /^ffmpeg exited with code 1: /.test(err.message) && err.message.includes('Invalid data found when processing input'),
    );
});

test('runFfmpeg kills the process and rejects when the timeout passes', { skip }, async () => {
    const started = Date.now();
    await assert.rejects(
        // lavfi has no end, so only the timeout can stop this.
        runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=200', '-y', '-f', 'null', '-'], { timeoutMs: 300 }),
        { message: 'process ran into a timeout (0.3s)' },
    );
    assert.ok(Date.now() - started < 5000);
});
