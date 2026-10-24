'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleErr } = require('./appDataContext');
const { HttpError } = require('../../core/http/errors');

function mockRes() {
    return {
        statusCode: null,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

test('a plain error with a 4xx status becomes a generic 500, not its own message', () => {
    for (const status of [404, 413, 429]) {
        const err = Object.assign(new Error(`internal detail ${status}`), { status });
        const res = mockRes();
        assert.throws(() => handleErr(res, err, 'x'), (thrown) => {
            assert.equal(thrown.status, undefined, 'no status rides along, so the terminal handler answers 500');
            assert.ok(!thrown.message.includes('internal detail'));
            assert.strictEqual(thrown.cause, err, 'the cause is kept for the log');
            return true;
        });
        assert.equal(res.statusCode, null, 'nothing is written here');
    }
});

test('an HttpError, a safe refusal and the frozen 4xx contracts keep their answer', () => {
    const http = new HttpError(404, 'not_found', 'Table not found');
    assert.throws(() => handleErr(mockRes(), http, 'x'), (thrown) => thrown === http);

    // A safe refusal leaves as an HttpError carrying its own message and status.
    assert.throws(() => handleErr(mockRes(), Object.assign(new Error('Forbidden'), { status: 403, safe: true }), 'x'), (thrown) => {
        assert.ok(thrown instanceof HttpError);
        assert.deepEqual([thrown.status, thrown.message], [403, 'Forbidden']);
        return true;
    });

    const quota = mockRes();
    handleErr(quota, Object.assign(new Error('Quota'), { status: 409, code: 'quota_exceeded', limit: 5, used: 5 }), 'x');
    assert.deepEqual([quota.statusCode, quota.body], [409, { error: 'Quota', code: 'quota_exceeded', limit: 5, used: 5 }]);
});
