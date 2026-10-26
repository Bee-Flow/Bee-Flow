/**
 * llmClient `rateLimit` option: with it, every adapter.chat inside chat() and
 * chatForcedTool() goes through the provider limiter (a 429 is waited out and
 * retried); without it the call is the plain adapter call it always was. The
 * option itself never reaches the adapter.
 *
 * Same strategy as llmClient.forcedTool.test.js: the config store is cut with
 * installResolveStub and `_resolve` is replaced by a fake adapter.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const { useConfigRows } = require('../../testUtils/configRows');

// The real configStore, its table empty: every key reads as absent.
const config = useConfigRows();

after(config.restore);

const llmClient = require('./llmClient');
const limiter = require('./providerLimiter');

// Waits stay tiny so a retry costs a few milliseconds. The limiter's sleep is unref'd
// (it must never keep a process alive), so the test holds the loop open itself.
process.env.LLM_RATE_LIMIT_MAX_WAIT_MS = '5';
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const TOOL_DEF = {
    type: 'function',
    function: { name: 'emit_result', description: 'x', parameters: { type: 'object', properties: { a: { type: 'string' } } } },
};

function rateErr() {
    const e = new Error('API error 429: slow down');
    e.status = 429;
    e.headers = { 'retry-after': '0.001' };
    return e;
}

/** A fake adapter whose chat() fails with a 429 `failures` times, then answers. */
function stubAdapter({ failures = 0, native = false } = {}) {
    const seen = [];
    let left = failures;
    const adapter = {
        name: 'stub',
        supportsStructuredOutput: () => native,
        chat: async (apiKey, url, modelId, messages, options) => {
            seen.push({ apiKey, url, modelId, options });
            if (left > 0) { left -= 1; throw rateErr(); }
            return native
                ? { content: '{"a":"x"}', usage: { prompt_tokens: 1, completion_tokens: 1 } }
                : { content: 'hi', toolCalls: [{ function: { name: 'emit_result', arguments: '{"a":"x"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
    };
    llmClient._resolve = async () => ({
        apiKey: 'key-1', baseUrl: 'https://provider.example/v1', adapter, providerType: 'stub', modelId: 'm',
        project: null, location: null, serviceAccountKey: null,
    });
    return { adapter, seen };
}

const original = llmClient._resolve;
beforeEach(() => { limiter._resetForTests(); });
after(() => { llmClient._resolve = original; });

test('chat with rateLimit: a 429 then success gives one result after one retry', async () => {
    const { seen } = stubAdapter({ failures: 1 });
    const out = await llmClient.chat('m', [{ role: 'user', content: 'hello' }], { temperature: 0, rateLimit: {} });
    assert.equal(out.content, 'hi');
    assert.equal(seen.length, 2);
});

test('chat: rateLimit is not forwarded to the adapter, the other options are', async () => {
    const { seen } = stubAdapter();
    await llmClient.chat('m', [], { temperature: 0.3, rateLimit: { signal: new AbortController().signal } });
    assert.equal(seen.length, 1);
    assert.ok(!('rateLimit' in seen[0].options));
    assert.equal(seen[0].options.temperature, 0.3);
    assert.equal(seen[0].apiKey, 'key-1');
    assert.equal(seen[0].url, 'https://provider.example/v1');
});

test('chat without rateLimit: a 429 goes straight out and nothing is retried', async () => {
    const { seen } = stubAdapter({ failures: 1 });
    await assert.rejects(llmClient.chat('m', [], { temperature: 0 }), /429/);
    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0].options).sort(), ['location', 'project', 'serviceAccountKey', 'temperature']);
});

test('chatForcedTool with rateLimit: tool route retries a 429 and strips the option', async () => {
    const { seen } = stubAdapter({ failures: 1 });
    const out = await llmClient.chatForcedTool('m', [], TOOL_DEF, { rateLimit: {} });
    assert.deepEqual(out.structured, { a: 'x' });
    assert.equal(seen.length, 2);
    assert.ok(seen.every(s => !('rateLimit' in s.options)));
});

test('chatForcedTool with rateLimit: the native structured route is limited too', async () => {
    const { seen } = stubAdapter({ failures: 1, native: true });
    const out = await llmClient.chatForcedTool('m', [], TOOL_DEF, { rateLimit: {} });
    assert.deepEqual(out.structured, { a: 'x' });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].options.responseFormat.type, 'json_schema');
});

test('chatForcedTool without rateLimit: a 429 is not retried', async () => {
    const { seen } = stubAdapter({ failures: 1 });
    await assert.rejects(llmClient.chatForcedTool('m', [], TOOL_DEF, {}), /429/);
    assert.equal(seen.length, 1);
});

test('an aborted signal stops the call before it reaches the adapter', async () => {
    const { seen } = stubAdapter();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(llmClient.chat('m', [], { rateLimit: { signal: ac.signal } }), /Run cancelled/);
    assert.equal(seen.length, 0);
});
