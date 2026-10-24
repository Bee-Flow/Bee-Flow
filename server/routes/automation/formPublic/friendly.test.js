// @typecheck
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { friendly } = require('./friendly');
const { HttpError } = require('../../../core/http/errors');

test('an unexpected failure becomes a 500 with the sentence the visitor used to read', async () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const wrapped = friendly(async () => { throw cause; }, 'pick_failed', 'That app could not be searched');
    await assert.rejects(wrapped({}, {}, () => {}), (err) => {
        assert.ok(err instanceof HttpError);
        assert.deepEqual([err.status, err.code, err.message, err.expose], [500, 'pick_failed', 'That app could not be searched', true]);
        assert.strictEqual(err.cause, cause, 'the cause stays for the log');
        return true;
    });
});

test('an HttpError and a normal answer pass through unchanged', async () => {
    const http = new HttpError(503, 'storage_unavailable', 'File storage is not available');
    await assert.rejects(friendly(async () => { throw http; }, 'upload_failed', 'Upload failed')({}, {}, () => {}), (err) => err === http);
    assert.equal(await friendly(async () => 'answered', 'x', 'y')({}, {}, () => {}), 'answered');
});
