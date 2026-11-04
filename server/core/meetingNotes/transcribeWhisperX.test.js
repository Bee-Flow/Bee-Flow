/**
 * transcribeWithWhisperX: the /transcribe deadline is WHISPERX_TIMEOUT_MS
 * (generous default, 0 = no limit), not a fixed 10 minutes.
 *
 * Run: cd server && node --test core/meetingNotes/transcribeWhisperX.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { makeSwaps } = require('../../testUtils/swaps');

// The real config store, its readers swapped: the URL comes from WHISPERX_URL.
const swaps = makeSwaps();
const configStore = require('../../stores/configStore');
swaps.swap(configStore, 'getSecret', async () => null);
swaps.swap(configStore, 'getConfig', async () => null);
test.after(() => swaps.restore());

const { transcribeWithWhisperX, whisperxTimeoutMs } = require('./transcribeWhisperX');

async function slowWhisperX(t, delayMs) {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => setTimeout(() => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ text: 'hi', segments: [{ text: 'hi', start: 0, end: 1, speakerId: 'SPEAKER_00' }] }));
        }, delayMs));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const env = { ...process.env };
    process.env.WHISPERX_URL = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-'));
    const file = path.join(dir, 'rec.mp3');
    fs.writeFileSync(file, 'AUDIO');
    t.after(() => {
        server.closeAllConnections();
        server.close();
        process.env = env;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return file;
}

test('the default budget is 30 minutes and 0 means no limit', () => {
    const env = process.env.WHISPERX_TIMEOUT_MS;
    try {
        delete process.env.WHISPERX_TIMEOUT_MS;
        assert.strictEqual(whisperxTimeoutMs(), 30 * 60_000);
        process.env.WHISPERX_TIMEOUT_MS = '0';
        assert.strictEqual(whisperxTimeoutMs(), 0);
        process.env.WHISPERX_TIMEOUT_MS = 'nonsense';
        assert.strictEqual(whisperxTimeoutMs(), 30 * 60_000);
    } finally {
        if (env === undefined) delete process.env.WHISPERX_TIMEOUT_MS; else process.env.WHISPERX_TIMEOUT_MS = env;
    }
});

test('a slow WhisperX within WHISPERX_TIMEOUT_MS answers', async (t) => {
    const file = await slowWhisperX(t, 200);
    process.env.WHISPERX_TIMEOUT_MS = '5000';
    const out = await transcribeWithWhisperX(file, 'rec.mp3', 'en', '');
    assert.strictEqual(out.segments[0].speakerId, 'SPEAKER_00');
});

test('a WhisperX slower than WHISPERX_TIMEOUT_MS is cut off at that budget', async (t) => {
    const file = await slowWhisperX(t, 1500);
    process.env.WHISPERX_TIMEOUT_MS = '100';
    await assert.rejects(() => transcribeWithWhisperX(file, 'rec.mp3', 'en', ''));
});
