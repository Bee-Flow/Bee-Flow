/**
 * Voxtral transcription: the recording is handed to the Mistral SDK as a File
 * backed by the file on disk (fs.openAsBlob), not as a Buffer read up front.
 * The real SDK serialises it into the multipart form against a local server.
 *
 * Run: cd server && node --test core/meetingNotes/ingestTranscription.voxtral.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const configPath = require.resolve('../../stores/configStore');
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { getSecret: async () => 'key', getConfig: async () => undefined },
};

const { Mistral } = require('@mistralai/mistralai');
const clientPath = require.resolve('./voxtralClient');
let serverURL;
require.cache[clientPath] = {
    id: clientPath, filename: clientPath, loaded: true,
    exports: { createVoxtralClient: (apiKey) => new Mistral({ apiKey, serverURL, retryConfig: { strategy: 'none' } }) },
};

// The ADTS repack needs ffmpeg; stand in for it so the test checks what the
// Voxtral leg SENDS, not ffmpeg. Non-.aac files pass through untouched, as in
// the real asM4aIfAdts.
const repackCalls = [];
const preprocessPath = require.resolve('../voice/audioPreprocess');
require.cache[preprocessPath] = {
    id: preprocessPath, filename: preprocessPath, loaded: true,
    exports: {
        asM4aIfAdts: async (inputPath, fileName) => {
            repackCalls.push(fileName);
            if (!/\.aac$/i.test(fileName)) return { path: inputPath, fileName, cleanup: () => {} };
            const out = `${inputPath}.m4a`;
            fs.copyFileSync(inputPath, out);
            return { path: out, fileName: fileName.replace(/\.aac$/i, '.m4a'), cleanup: () => fs.rmSync(out, { force: true }) };
        },
    },
};

const { transcribe } = require('./ingestTranscription');

test('voxtral sends the on-disk recording as a named, typed multipart file', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            received.push({ headers: req.headers, body: Buffer.concat(chunks) });
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ model: 'voxtral-mini-2602', text: 'hello', segments: [], language: 'en', usage: {} }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    serverURL = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxtral-'));
    const file = path.join(dir, 'rec.mp3');
    const audio = Buffer.from('AUDIO-BYTES-123');
    fs.writeFileSync(file, audio);
    try {
        const { response } = await transcribe('voxtral', { filePath: file, fileName: 'rec.mp3', language: 'en', contextTerms: [] });
        assert.strictEqual(response.text, 'hello');
        const body = received[0].body;
        assert.ok(body.includes(audio), 'the audio bytes are in the form');
        const text = body.toString('latin1');
        assert.match(text, /name="file"; filename="rec\.mp3"/);
        assert.match(text, /Content-Type: audio\/mpeg/i);
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an .aac recording from a Nextcloud/Talk import is repacked to .m4a before it goes to Voxtral', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            received.push(Buffer.concat(chunks));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ model: 'voxtral-mini-2602', text: 'hi', segments: [], language: 'en', usage: {} }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    serverURL = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxtral-aac-'));
    const file = path.join(dir, 'phone-meeting.aac');
    fs.writeFileSync(file, Buffer.from('ADTS-BYTES'));
    try {
        await transcribe('voxtral', { filePath: file, fileName: 'phone-meeting.aac', language: 'en', contextTerms: [] });
        const text = received[0].toString('latin1');
        assert.match(text, /filename="phone-meeting\.m4a"/);
        assert.doesNotMatch(text, /audio\/aac/i);
        assert.ok(!fs.existsSync(`${file}.m4a`), 'the repacked temp file is cleaned up');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
