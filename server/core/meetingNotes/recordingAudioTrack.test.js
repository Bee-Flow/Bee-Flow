'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runFfmpeg } = require('../media/ffmpeg');
const { hasVideoStream, audioForTranscription, engineFileName } = require('./recordingAudioTrack.mts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-audio-track-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A one-second file made by the bundled ffmpeg, with or without a picture. */
async function makeRecording(name, { video }) {
    const out = path.join(dir, name);
    const args = video
        ? ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', out]
        : ['-y', '-f', 'lavfi', '-i', 'sine=d=1', '-c:a', 'aac', out];
    await runFfmpeg(args, { timeoutMs: 30_000 });
    return out;
}

test('a Talk video recording is recognised as video', async () => {
    const file = await makeRecording('talk-video.mp4', { video: true });
    assert.strictEqual(await hasVideoStream(file), true);
});

test('an audio-only .mp4 is not video', async () => {
    const file = await makeRecording('audio-only.mp4', { video: false });
    assert.strictEqual(await hasVideoStream(file), false);
});

test('a file ffmpeg cannot read counts as audio, so it is transcribed as before', async () => {
    const file = path.join(dir, 'garbage.mp4');
    fs.writeFileSync(file, 'not a recording');
    assert.strictEqual(await hasVideoStream(file), false);
});

test('the engine gets only the sound of a video recording', async () => {
    const file = await makeRecording('meeting.mp4', { video: true });
    const audio = await audioForTranscription(file);
    assert.strictEqual(audio.extracted, true);
    assert.notStrictEqual(audio.path, file);
    assert.ok(fs.existsSync(audio.path));
    assert.strictEqual(await hasVideoStream(audio.path), false);
    // The original stays for playback.
    assert.ok(fs.existsSync(file));
});

test('an audio recording goes to the engine untouched', async () => {
    const file = await makeRecording('voice.m4a', { video: false });
    assert.deepStrictEqual(await audioForTranscription(file), { path: file, extracted: false });
});

test('extracted sound lands in outDir under a fresh name', async () => {
    const file = await makeRecording('saved.mp4', { video: true });
    const out = fs.mkdtempSync(path.join(dir, 'scratch-'));
    const a = await audioForTranscription(file, { outDir: out });
    const b = await audioForTranscription(file, { outDir: out });
    assert.strictEqual(path.dirname(a.path), out);
    assert.notStrictEqual(a.path, b.path);
});

test('the engine is told the name of what it hears', () => {
    assert.strictEqual(engineFileName('Overleg 12-11.webm', '/tmp/x.audio.m4a'), 'Overleg 12-11.m4a');
    assert.strictEqual(engineFileName('voice.m4a', '/tmp/voice.m4a'), 'voice.m4a');
});
