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
