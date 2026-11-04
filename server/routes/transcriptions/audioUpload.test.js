// @typecheck
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const multer = require('multer');
const { HttpError } = require('../../core/http/errors');
const { uploadErrorHandler, UNSUPPORTED_AUDIO_FORMAT } = require('./audioUpload');

function run(err) {
    const res = {
        statusCode: 200, body: undefined,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
    let forwarded;
    uploadErrorHandler(err, {}, res, (e) => { forwarded = e; });
    return { res, forwarded };
}

test('a multer size limit keeps its 400 and fixed sentence', () => {
    const { res, forwarded } = run(new multer.MulterError('LIMIT_FILE_SIZE'));
    assert.strictEqual(forwarded, undefined);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'File too large. Maximum size is 500 MB.' });
});

test('any other multer error is a 400 HttpError with multer\'s own message', () => {
    const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE');
    const { res, forwarded } = run(err);
    assert.strictEqual(res.body, undefined);
    assert.ok(forwarded instanceof HttpError);
    assert.deepStrictEqual([forwarded.status, forwarded.code, forwarded.message], [400, 'upload_failed', err.message]);
});

test('the audio-format filter\'s refusal is a 400 HttpError naming the formats', () => {
    const err = new Error('Unsupported audio format. Supported: MP3');
    err.code = UNSUPPORTED_AUDIO_FORMAT;
    const { res, forwarded } = run(err);
    assert.strictEqual(res.body, undefined);
    assert.ok(forwarded instanceof HttpError);
    assert.deepStrictEqual([forwarded.status, forwarded.code, forwarded.message], [400, 'unsupported_audio_format', 'Unsupported audio format. Supported: MP3']);
});

test('everything else goes on to the terminal handler, never echoed here', () => {
    for (const err of [
        new Error('relation "transcriptions" does not exist'),
        new HttpError(503, 'unavailable', 'Storage down'),
        new HttpError(404, 'not_found', 'Not found'),
    ]) {
        const { res, forwarded } = run(err);
        assert.strictEqual(forwarded, err);
        assert.strictEqual(res.body, undefined);
    }
});

test('an error after the parser removes the scratch file multer wrote', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const scratch = path.join(os.tmpdir(), `audio-upload-scratch-${Date.now()}`);
    fs.writeFileSync(scratch, 'meeting audio');
    const err = new HttpError(400, 'invalid_request', 'num_speakers is een getal.');
    let forwarded;
    uploadErrorHandler(err, { file: { path: scratch } }, {}, (e) => { forwarded = e; });
    assert.strictEqual(forwarded, err, 'the refusal itself still goes to the terminal handler');
    for (let i = 0; i < 50 && fs.existsSync(scratch); i++) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(fs.existsSync(scratch), false, 'no meeting audio is left behind in the scratch dir');
});

test('a non-ASCII file name arrives as UTF-8, not as latin1 mojibake', async () => {
    const http = require('http');
    const express = require('express');
    const { upload } = require('./audioUpload');
    const app = express();
    let seen = null;
    app.post('/', upload.single('audio'), (req, res) => {
        seen = req.file.originalname;
        require('fs').unlink(req.file.path, () => {});
        res.json({ ok: true });
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, () => r(undefined)));
    try {
        const form = new FormData();
        form.append('audio', new Blob([Buffer.from('x')], { type: 'audio/webm' }), 'Overleg café – Q3.m4a');
        const { port } = /** @type {import('net').AddressInfo} */ (server.address());
        const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: form });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(seen, 'Overleg café – Q3.m4a');
    } finally {
        await new Promise((r) => server.close(r));
    }
});
