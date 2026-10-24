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
