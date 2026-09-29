/**
 * The builder tells the user what the provider actually said.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/providerError.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { providerErrorExcerpt } = require('./chatTurnLoop');

test('a llama-server 400 body yields the template\'s own message, not the JSON envelope', () => {
    const msg = 'openai-compatible API error 400: {"error":{"code":400,"message":"Unable to generate parser for this template. Automatic parser generation failed: \\n------------\\nWhile executing CallExpression at line 110\\nError: Jinja Exception: System message must be at the beginning.","type":"invalid_request_error"}}';
    const out = providerErrorExcerpt(msg);
    assert.ok(out.startsWith('Unable to generate parser'), out);
    assert.ok(out.includes('System message must be at the beginning'), out);
    assert.ok(!out.includes('{"error"'), 'no JSON envelope');
    assert.ok(!out.includes('\n'), 'single line');
});

test('a non-JSON body is trimmed to a readable tail', () => {
    const out = providerErrorExcerpt('Local API error 413: ' + 'x'.repeat(1000));
    assert.ok(out.length <= 240);
    assert.ok(out.endsWith('…'));
});

test('a message without the adapter prefix is returned as-is', () => {
    assert.strictEqual(providerErrorExcerpt('fetch failed'), 'fetch failed');
});
