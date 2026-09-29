/**
 * NPU Whisper — the audio arithmetic, which is where the real risk lives.
 *
 * The endpoint returns text and nothing else, so this module derives its own
 * segment boundaries from the PCM. Three things can go wrong silently and all
 * three are pinned here:
 *   1. assuming a 44-byte WAV header (some encoders put LIST/INFO chunks first,
 *      and mis-locating `data` splices metadata into the audio);
 *   2. cutting at an odd byte offset, which swaps the bytes of every sample in
 *      the chunk and turns speech into noise;
 *   3. sending a silent chunk, which makes Whisper hallucinate — observed for
 *      real: a 2 s silent tail produced "E aí E aí E aí…" in Portuguese on an
 *      English-forced request, and that text landed in the transcript.
 *
 * Run: cd server && node --test --test-force-exit core/voice/npuWhisper.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const stubPath = path.join(__dirname, '..', '..', 'stores', 'configStore.js');
require.cache[stubPath] = {
    id: stubPath, filename: stubPath, loaded: true,
    exports: { async getConfig() { return undefined; }, async getSecret() { return null; } },
};

const { _internals } = require('./npuWhisper');
const { findDataChunk, wavHeader, planCuts, rmsOf, WINDOW_SEC, BYTES_PER_SEC, SILENCE_RMS } = _internals;

/** Tone at a given amplitude, `sec` seconds of 16 kHz mono s16le. */
function tone(sec, amplitude = 6000) {
    const buf = Buffer.alloc(Math.floor(sec * BYTES_PER_SEC));
    for (let i = 0; i + 1 < buf.length; i += 2) {
        buf.writeInt16LE(Math.round(amplitude * Math.sin((i / 2) * 0.05)), i);
    }
    return buf;
}
const silence = (sec) => Buffer.alloc(Math.floor(sec * BYTES_PER_SEC));

test('findDataChunk walks the chunk list instead of assuming offset 44', () => {
    const data = tone(0.1);
    // A LIST chunk sits between `fmt ` and `data`, exactly as some encoders emit.
    const list = Buffer.alloc(8 + 10);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(10, 4);

    const fmt = wavHeader(data.length).subarray(12, 36); // fmt chunk only
    const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, list, Buffer.from('data', 'ascii'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(data.length); return b; })(), data]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(body.length, 4);
    const wav = Buffer.concat([riff, body]);

    const found = findDataChunk(wav);
    assert.ok(found, 'data chunk must be found past the LIST chunk');
    assert.strictEqual(found.size, data.length);
    assert.notStrictEqual(found.start, 44, 'this file genuinely does not start its samples at 44');
    assert.deepStrictEqual(wav.subarray(found.start, found.start + found.size), data);
});

test('findDataChunk rejects non-RIFF input rather than guessing', () => {
    assert.strictEqual(findDataChunk(Buffer.from('not a wav file at all')), null);
    assert.strictEqual(findDataChunk(Buffer.alloc(4)), null);
});

test('a truncated data chunk is clamped to what is actually present', () => {
    // A header claiming more samples than the file holds must not produce a
    // slice that runs off the end of the buffer.
    const header = wavHeader(10 * BYTES_PER_SEC);
    const wav = Buffer.concat([header, tone(0.05)]);
    const found = findDataChunk(wav);
    assert.ok(found.start + found.size <= wav.length, 'size must be clamped to the buffer');
});

test('wavHeader declares the sizes it was given', () => {
    const h = wavHeader(32000);
    assert.strictEqual(h.length, 44);
    assert.strictEqual(h.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(h.toString('ascii', 8, 12), 'WAVE');
    assert.strictEqual(h.readUInt32LE(4), 36 + 32000, 'RIFF size = 36 + data');
    assert.strictEqual(h.readUInt32LE(40), 32000, 'data size');
    assert.strictEqual(h.readUInt16LE(22), 1, 'mono');
    assert.strictEqual(h.readUInt32LE(24), 16000, '16 kHz');
    assert.strictEqual(h.readUInt16LE(34), 16, '16-bit');
});

test('short audio is one window', () => {
    const pcm = tone(WINDOW_SEC - 5);
    assert.deepStrictEqual(planCuts(pcm, WINDOW_SEC - 5), [0, pcm.length]);
});

test('cuts land in the silence, not mid-word', () => {
    // Speech up to the window boundary, then a clear 3 s gap, then more speech.
    const gapStart = WINDOW_SEC + 1;
    const pcm = Buffer.concat([tone(gapStart), silence(3), tone(40)]);
    const total = pcm.length / BYTES_PER_SEC;
    const cuts = planCuts(pcm, total);

    assert.ok(cuts.length >= 3, `expected at least one interior cut, got ${cuts.length - 1} window(s)`);
    const cutSec = cuts[1] / BYTES_PER_SEC;
    assert.ok(cutSec >= gapStart && cutSec <= gapStart + 3,
        `cut at ${cutSec.toFixed(2)}s should sit inside the ${gapStart}-${gapStart + 3}s silence`);
});

test('every cut is sample-aligned', () => {
    // An odd offset would misalign every subsequent 16-bit sample.
    const pcm = Buffer.concat([tone(WINDOW_SEC + 1), silence(2), tone(WINDOW_SEC + 1), silence(2), tone(30)]);
    for (const c of planCuts(pcm, pcm.length / BYTES_PER_SEC)) {
        assert.strictEqual(c % 2, 0, `cut ${c} must be on a 16-bit sample boundary`);
    }
});

test('cuts are strictly increasing and span the whole buffer', () => {
    const pcm = Buffer.concat([tone(WINDOW_SEC + 1), silence(2), tone(WINDOW_SEC + 1), silence(2), tone(WINDOW_SEC)]);
    const cuts = planCuts(pcm, pcm.length / BYTES_PER_SEC);
    assert.strictEqual(cuts[0], 0);
    assert.strictEqual(cuts[cuts.length - 1], pcm.length, 'the last cut must reach the end — no audio dropped');
    for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i] > cuts[i - 1], 'cuts must advance');
});

test('a stubby silent tail is merged, not shipped as its own request', () => {
    // The regression: [180s..182s] of room tone went out as a chunk of its own
    // and came back as invented Portuguese.
    const pcm = Buffer.concat([tone(WINDOW_SEC * 3), silence(2)]);
    const cuts = planCuts(pcm, pcm.length / BYTES_PER_SEC);
    const lastWindowSec = (cuts[cuts.length - 1] - cuts[cuts.length - 2]) / BYTES_PER_SEC;
    assert.ok(lastWindowSec > 5, `tail window ${lastWindowSec.toFixed(1)}s should have been merged into the previous one`);
});

test('rmsOf separates silence from speech either side of the gate', () => {
    assert.strictEqual(rmsOf(silence(1)), 0, 'digital silence is 0');
    assert.ok(rmsOf(silence(1)) < SILENCE_RMS, 'silence is gated out');
    assert.ok(rmsOf(tone(1, 6000)) > SILENCE_RMS * 10, 'speech-level audio passes comfortably');
    // A very quiet speaker must still get through — the gate is for true
    // silence, not for quiet rooms.
    assert.ok(rmsOf(tone(1, 400)) > SILENCE_RMS, 'a quiet talker is not mistaken for silence');
});
