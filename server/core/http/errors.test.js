const test = require('node:test');
const assert = require('node:assert');

const { HttpError, badRequest, notFound, unavailable } = require('./errors');

test('carries status, code and message, and is an Error', () => {
    const e = new HttpError(404, 'agent_not_found', 'Agent not found');
    assert.ok(e instanceof Error);
    assert.strictEqual(e.status, 404);
    assert.strictEqual(e.code, 'agent_not_found');
    assert.strictEqual(e.message, 'Agent not found');
    assert.strictEqual(e.name, 'HttpError');
});

test('is written for the caller whatever the status', () => {
    assert.strictEqual(badRequest('bad', 'nope').expose, true);
    assert.strictEqual(notFound().expose, true);
    assert.strictEqual(unavailable().expose, true);
});

test('falls back to the code, then the status, for the message', () => {
    assert.strictEqual(new HttpError(409, 'dup').message, 'dup');
    assert.strictEqual(new HttpError(418).message, 'HTTP 418');
});

test('details ride along when given', () => {
    const e = badRequest('invalid_body', 'Body invalid', [{ path: 'name', issue: 'required' }]);
    assert.deepStrictEqual(e.details, [{ path: 'name', issue: 'required' }]);
    assert.strictEqual('details' in notFound(), false);
});
