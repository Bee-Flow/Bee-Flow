/**
 * Audio conditioning — runs the REAL ffmpeg (via @ffmpeg-installer).
 *
 * Exists because a stubbed `preprocessForStt` cannot tell you whether the
 * option you passed did anything. `maxSeconds` was once documented, passed by
 * the caller, and asserted on in a test that stubbed this module — while the
 * ffmpeg chain quietly ignored it, so voiceprint enrollment shipped
 * over-length audio to pyannoteAI. Options are verified against the OUTPUT
 * here, not against the call.
 *
 * Run: cd server && node --test core/voice/audioPreprocess.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { preprocessForStt, SAMPLE_RATE } = require('./audioPreprocess');

let ffmpeg = null;
try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    ffmpeg = require('fluent-ffmpeg');
    ffmpeg.setFfmpegPath(installer.path);
} catch (_) { /* covered by the skip below */ }

/** Seconds of 16-bit PCM in a WAV, from the `data` chunk size. */
function wavSeconds(file, sampleRate = SAMPLE_RATE, channels = 1) {
    const buf = fs.readFileSync(file);
    let offset = 12;
    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        if (id === 'data') return Math.min(size, buf.length - offset - 8) / (2 * channels) / sampleRate;
        offset += 8 + size + (size % 2);
    }
    return 0;
}

async function makeTone(seconds, out) {
    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(`sine=frequency=200:duration=${seconds}`).inputFormat('lavfi')
            .audioCodec('libopus').format('webm')
            .on('end', resolve).on('error', reject)
            .save(out);
    });
    return out;
}

const made = [];
function tmp(ext) {
    const p = path.join(os.tmpdir(), `apre-test-${Date.now()}-${made.length}${ext}`);
    made.push(p);
    return p;
}
test.after(() => { for (const p of made) { try { fs.unlinkSync(p); } catch (_) {} } });

test('maxSeconds actually CLIPS the output', { skip: !ffmpeg && 'ffmpeg unavailable' }, async () => {
    const src = await makeTone(20, tmp('.webm'));
    const out = await preprocessForStt(src, { format: 'wav', label: 'test', maxSeconds: 8 });
    assert.strictEqual(out.preprocessed, true);
    const secs = wavSeconds(out.path);
    assert.ok(secs > 7.5 && secs <= 8.5, `expected ~8s, got ${secs.toFixed(2)}s`);
    out.cleanup();
});

test('without maxSeconds the full length is kept (every other caller)', { skip: !ffmpeg && 'ffmpeg unavailable' }, async () => {
    const src = await makeTone(6, tmp('.webm'));
    const out = await preprocessForStt(src, { format: 'wav', label: 'test' });
    const secs = wavSeconds(out.path);
    assert.ok(secs > 5.5, `expected the whole 6s, got ${secs.toFixed(2)}s`);
    out.cleanup();
});

test('output is 16kHz mono in the requested container', { skip: !ffmpeg && 'ffmpeg unavailable' }, async () => {
    // `buf` is the WAV this test's own ffmpeg run just produced, read back to
    // check its real header bytes — not a source file. The source-text
    // counter cannot tell the two apart (it flags any readFileSync var an
    // assertion names), but this is exactly "assert on the output" behaviour,
    // not the antipattern it looks for.
    const src = await makeTone(3, tmp('.webm'));
    const wav = await preprocessForStt(src, { format: 'wav', label: 'test' });
    const buf = fs.readFileSync(wav.path);
    assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(buf.readUInt16LE(22), 1, 'mono');
    assert.strictEqual(buf.readUInt32LE(24), SAMPLE_RATE);
    wav.cleanup();

    const flac = await preprocessForStt(src, { format: 'flac', label: 'test' });
    assert.strictEqual(fs.readFileSync(flac.path).toString('ascii', 0, 4), 'fLaC');
    flac.cleanup();
});

test('an undecodable input degrades to the original rather than throwing', async () => {
    // A conditioning problem must never cost a user their transcription.
    const src = tmp('.webm');
    fs.writeFileSync(src, 'not audio at all');
    const out = await preprocessForStt(src, { format: 'wav', label: 'test' });
    assert.strictEqual(out.preprocessed, false);
    assert.strictEqual(out.path, src, 'the caller gets its original file back');
    out.cleanup();
    assert.ok(fs.existsSync(src), 'cleanup() must not delete the caller\'s own file');
});
