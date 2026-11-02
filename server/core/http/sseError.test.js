'use strict';
/** SSE error events carry a classified message, never the raw error text. Run: node --test core/http/sseError.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { sseErrorPayload } = require('./sseError.mts');
const { HttpError } = require('./errors');

test('an internal error is answered with the classified wording and a correlation id', () => {
    const p = sseErrorPayload(new Error('relation "secret_table" does not exist at /srv/app/x.js'), { tag: '[t]', correlationId: 'req-1' });
    assert.equal(p.error, 'An unexpected error occurred');
    assert.equal(p.correlationId, 'req-1');
    assert.ok(!JSON.stringify(p).includes('secret_table'));
});

test('a provider failure keeps its retryable classification', () => {
    const p = sseErrorPayload(Object.assign(new Error('upstream body: {"key":"sk-..."}'), { status: 503 }), { tag: '[t]' });
    assert.equal(p.errorType, 'transient');
    assert.ok(!p.error.includes('sk-'));
    assert.ok(p.correlationId);
});

test('a client error (HttpError below 500) keeps its message and code', () => {
    const p = sseErrorPayload(new HttpError(409, 'automation_owner_inactive', 'The owner of this automation can no longer run it.'), { tag: '[t]' });
    assert.equal(p.error, 'The owner of this automation can no longer run it.');
    assert.equal(p.code, 'automation_owner_inactive');
});

test('the request id of `req` is the correlation id when none is passed', () => {
    assert.equal(sseErrorPayload(new Error('x'), { tag: '[t]', req: { id: 'req-7' } }).correlationId, 'req-7');
    assert.notEqual(sseErrorPayload(new Error('x'), { tag: '[t]', req: {} }).correlationId, '');
});
