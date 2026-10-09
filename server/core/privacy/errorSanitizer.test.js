const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyErrorCode } = require('./errorSanitizer');

function apiError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

test('a full context window reported as a 400 is context_overflow, not bad_request', () => {
    assert.equal(classifyErrorCode(apiError(400, "This model's maximum context length is 128000 tokens")), 'context_overflow');
    assert.equal(classifyErrorCode(apiError(400, 'prompt is too long: 210000 tokens > 200000 maximum')), 'context_overflow');
});

test('other 400s stay bad_request', () => {
    assert.equal(classifyErrorCode(apiError(400, 'Invalid body: failed to parse JSON value')), 'bad_request');
    assert.equal(classifyErrorCode(apiError(400, "Invalid type for 'messages[4].content'")), 'bad_request');
});

test('a 413 stays payload_too_large', () => {
    assert.equal(classifyErrorCode(apiError(413, 'Request entity too large')), 'payload_too_large');
});
