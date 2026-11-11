const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toFriendlyTurnError } = require('./turnErrors');

test('provider context-length errors become one clear message', () => {
    for (const raw of [
        'API error 400: prompt is too long: 250000 tokens > 200000 maximum',
        'context_length_exceeded',
        "This model's maximum context length is 128000 tokens",
    ]) {
        assert.match(toFriendlyTurnError(raw), /contextvenster/);
    }
});

test('other 4xx provider errors and unknown text keep their old handling', () => {
    assert.match(toFriendlyTurnError('API error 429: slow down'), /^AI-provider gaf een fout terug/);
    assert.equal(toFriendlyTurnError('boom'), 'boom');
});
