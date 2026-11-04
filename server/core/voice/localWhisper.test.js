// @typecheck
/**
 * Local (CPU) whisper decode: the duration cap bounds the decode itself.
 *
 * Runs the REAL ffmpeg (via @ffmpeg-installer). The CPU model rejects audio
 * over its cap, and the decode used to turn the WHOLE recording into 16 kHz
 * float (64 KB per audio second, on disk and in one Buffer) before that check
 * ran: a multi-hour upload cost gigabytes just to learn it was too long, and
 * past the 2 GiB readFile limit the cloud fallback never ran.
 *
 * Run: cd server && node --test core/voice/localWhisper.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _decodeArgs, _decodeWithinCap } = require('./localWhisper');

/** @type {typeof import('../media/ffmpeg') | null} */
let ffmpeg = null;
try {
    require('@ffmpeg-installer/ffmpeg');
    ffmpeg = require('../media/ffmpeg');
} catch (_) { /* covered by the skip below */ }

/** @type {string[]} */
const made = [];
/**
 * @param {number} seconds
 */
async function makeTone(seconds) {
    const out = path.join(os.tmpdir(), `lwhisper-test-${process.pid}-${made.length}.webm`);
    made.push(out);
    await /** @type {typeof import('../media/ffmpeg')} */ (ffmpeg).runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=200:duration=${seconds}`, '-y', '-acodec', 'libopus', '-f', 'webm', out]);
    return out;
}
test.after(() => { for (const p of made) { try { fs.unlinkSync(p); } catch (_) { /* already gone */ } } });

test('the decode is clipped one second past the cap', () => {
    const args = _decodeArgs('/in/a.webm', '/tmp/o.f32', 601);
    const t = args.indexOf('-t');
    assert.ok(t > 0, 'decode must pass -t to ffmpeg');
    assert.strictEqual(args[t + 1], '601');
    assert.strictEqual(args[args.length - 1], '/tmp/o.f32');
});

test('a recording over the cap is refused without decoding it whole', { skip: !ffmpeg && 'ffmpeg unavailable' }, async () => {
    const src = await makeTone(30);
    const readFile = fs.promises.readFile;
    /** @type {number[]} */
    const readSizes = [];
    fs.promises.readFile = /** @type {typeof readFile} */ (async (/** @type {any} */ p, /** @type {any} */ o) => {
        const buf = await readFile(p, o);
        if (String(p).endsWith('.f32')) readSizes.push(buf.length);
        return buf;
    });
    try {
        await assert.rejects(_decodeWithinCap(src, 5), (/** @type {any} */ err) => err.code === 'local_whisper_too_long');
    } finally {
        fs.promises.readFile = readFile;
    }
    assert.strictEqual(readSizes.length, 1);
    // 6 s (cap + 1) of 16 kHz f32 is 384,000 bytes; the whole 30 s would be 1,920,000.
    assert.ok(readSizes[0] <= 6 * 16000 * 4, `decoded ${readSizes[0]} bytes, expected at most 6 s worth`);
});

test('a recording within the cap is decoded in full', { skip: !ffmpeg && 'ffmpeg unavailable' }, async () => {
    const src = await makeTone(3);
    const samples = await _decodeWithinCap(src, 5);
    const secs = samples.length / 16000;
    assert.ok(secs > 2.5 && secs <= 3.5, `expected ~3s, got ${secs.toFixed(2)}s`);
});
