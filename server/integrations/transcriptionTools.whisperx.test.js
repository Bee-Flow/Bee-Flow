'use strict';
/**
 * WhisperX upload: a real multipart body on the first call and on the 404
 * fallback. Runs against a local HTTP server; the store's readers are swapped.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

let baseUrl = '';
// The real store, its readers swapped (transcriptionTools reads it per call).
const configStore = require('../stores/configStore');
configStore.getSecret = async (key) => (key === 'whisperx_url' ? baseUrl : null);
configStore.getConfig = async () => 'whisperx';

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
            { provider: 'whisperx', language: 'en' },
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
