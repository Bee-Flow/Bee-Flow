'use strict';
/**
 * WhisperX upload: a real multipart body on the first call and on the 404
 * fallback. Runs against a local HTTP server; the store's readers are swapped.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

let baseUrl = '';
let secretUrl = true;
// The real store, its readers swapped (transcriptionTools reads it per call).
const configStore = require('../stores/configStore');
configStore.getSecret = async (key) => (key === 'whisperx_url' && secretUrl ? baseUrl : null);
configStore.getConfig = async () => 'whisperx';
// The speaker-name step after a successful transcript: never a real model.
const llmClient = require('../core/llm/llmClient');
const realChat = llmClient.chat;
llmClient.chat = async () => ({ content: '{}' });
test.after(() => { llmClient.chat = realChat; });
// The deployment wiring these tests set themselves; start from none.
delete process.env.WHISPERX_URL;
delete process.env.SERVICES_API_KEY;

const { executeTranscriptionTool } = require('./transcriptionTools');

test('whisperx: multipart body arrives intact on /transcribe and on the 404 fallback', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            seen.push({ url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks) });
            if (req.url === '/transcribe') { res.statusCode = 404; res.end('nope'); return; }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ segments: [] }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
        const audio = Buffer.from('AUDIO-BYTES-123');
        await executeTranscriptionTool(
            'transcribe_audio',
            { language: 'en' },
            { userId: 'u1', attachments: [{ name: 'a.mp3', data: audio }] },
        );
    } finally {
        server.close();
    }
    assert.deepStrictEqual(seen.map((s) => s.url), ['/transcribe', '/v1/audio/transcriptions']);
    for (const s of seen) {
        const m = /^multipart\/form-data; boundary=(.+)$/.exec(s.type || '');
        assert.ok(m, `multipart content-type, got ${s.type}`);
        const text = s.body.toString('latin1');
        assert.ok(text.startsWith(`--${m[1]}`), 'body starts with the boundary');
        assert.ok(text.trimEnd().endsWith(`--${m[1]}--`), 'body ends with the closing boundary');
        assert.match(text, /name="audio"; filename="a\.mp3"/);
        assert.match(text, /name="file"; filename="a\.mp3"/);
        assert.ok(text.includes('AUDIO-BYTES-123'));
        assert.match(text, /name="language"\r\n\r\nen/);
    }
});

/** A WhisperX stand-in behind the shared services key gate. */
async function gatedServer(key) {
    const seen = [];
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            seen.push({ url: req.url, apiKey: req.headers['x-api-key'] || null });
            if (req.headers['x-api-key'] !== key) { res.statusCode = 401; res.end('missing api key'); return; }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ segments: [{ speaker: 'S1', start: 0, end: 1, text: 'hello' }] }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

test('whisperx: WHISPERX_URL and SERVICES_API_KEY from the deployment are used, like the meeting path', async (t) => {
    const { server, seen, url } = await gatedServer('svc-key');
    secretUrl = false;
    process.env.WHISPERX_URL = url;
    process.env.SERVICES_API_KEY = 'svc-key';
    t.after(() => {
        server.close();
        secretUrl = true;
        delete process.env.WHISPERX_URL;
        delete process.env.SERVICES_API_KEY;
    });
    const res = await executeTranscriptionTool(
        'transcribe_audio',
        { language: 'en' },
        { userId: 'u1', attachments: [{ name: 'a.mp3', data: Buffer.from('AUDIO') }] },
    );
    assert.ok(!res.error, `no error, got ${res.error}`);
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(seen, [{ url: '/transcribe', apiKey: 'svc-key' }]);
});
