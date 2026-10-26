// @typecheck strict
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderLimiter, limiterKeyFor, estimateRequestTokens, rateLimitInfo } = require('./providerLimiter');

/** A limiter on a fake clock: sleep advances time and records the waits. */
function fakeLimiter(env = {}) {
    /** @type {{ t: number, waits: number[] }} */
    const clock = { t: 1_000_000, waits: [] };
    const limiter = createProviderLimiter({
        now: () => clock.t,
        sleep: async (ms) => { clock.waits.push(ms); clock.t += ms; },
        env,
    });
    return { limiter, clock };
}

/**
 * @param {number} status
 * @param {Record<string, unknown> | Headers} [headers]
 */
function rateErr(status, headers) {
    const e = /** @type {any} */ (new Error(`API error ${status}`));
    e.status = status;
    if (headers) e.headers = headers;
    return e;
}

test('rpm bucket blocks the call after the budget until it refills', async () => {
    const { limiter, clock } = fakeLimiter({ LLM_PROVIDER_RPM: '2', LLM_PROVIDER_TPM: '0' });
    await limiter.acquire('k', { tokens: 1 });
    await limiter.acquire('k', { tokens: 1 });
    assert.deepEqual(clock.waits, []);
    await limiter.acquire('k', { tokens: 1 });
    // 2 per minute: one request every 30 s.
    assert.equal(clock.waits.length, 1);
    assert.ok(clock.waits[0] >= 29_000 && clock.waits[0] <= 30_000, `waited ${clock.waits[0]}`);
});

test('tpm bucket: settle corrects the estimate in both directions', async () => {
    const { limiter, clock } = fakeLimiter({ LLM_PROVIDER_RPM: '0', LLM_PROVIDER_TPM: '600' });
    const lease = await limiter.acquire('k', { tokens: 600 });
    lease.settle(100); // the call used far less: 500 come back
    await limiter.acquire('k', { tokens: 500 });
    assert.deepEqual(clock.waits, []);
    const second = fakeLimiter({ LLM_PROVIDER_RPM: '0', LLM_PROVIDER_TPM: '600' });
    const l2 = await second.limiter.acquire('k', { tokens: 100 });
    l2.settle(600); // used more than estimated: the bucket is empty now
    await second.limiter.acquire('k', { tokens: 60 });
    assert.equal(second.clock.waits.length, 1);
    assert.ok(second.clock.waits[0] > 0);
    assert.deepEqual(clock.waits, []);
});

test('a request larger than the token capacity is clipped and never waits forever', async () => {
    const { limiter, clock } = fakeLimiter({ LLM_PROVIDER_RPM: '0', LLM_PROVIDER_TPM: '1000' });
    await limiter.acquire('k', { tokens: 5_000_000 });
    assert.deepEqual(clock.waits, []);
});

test('0 means unlimited for requests and tokens', async () => {
    const { limiter, clock } = fakeLimiter({ LLM_PROVIDER_RPM: '0', LLM_PROVIDER_TPM: '0' });
    for (let i = 0; i < 50; i++) await limiter.acquire('k', { tokens: 1_000_000 });
    assert.deepEqual(clock.waits, []);
});

test('waiters on one key are served first come, first served', async () => {
    const { limiter } = fakeLimiter({ LLM_PROVIDER_RPM: '1', LLM_PROVIDER_TPM: '0' });
    /** @type {number[]} */
    const order = [];
    /** @param {number} n */
    const run = (n) => limiter.acquire('k', { tokens: 1 }).then(() => order.push(n));
    await Promise.all([run(1), run(2), run(3), run(4)]);
    assert.deepEqual(order, [1, 2, 3, 4]);
});

test('different keys do not share a budget', async () => {
    const { limiter, clock } = fakeLimiter({ LLM_PROVIDER_RPM: '1', LLM_PROVIDER_TPM: '0' });
    await limiter.acquire('a');
    await limiter.acquire('b');
    assert.deepEqual(clock.waits, []);
});

test('429 with a numeric Retry-After (Headers.get form) waits that long and retries once', async () => {
    const { limiter, clock } = fakeLimiter({});
    let calls = 0;
    const out = await limiter.withRateLimit({ key: 'k', estimateTokens: 10 }, async () => {
        calls += 1;
        if (calls === 1) throw rateErr(429, new Headers({ 'retry-after': '7' }));
        return { ok: true, usage: { prompt_tokens: 3, completion_tokens: 2 } };
    });
    assert.equal(calls, 2);
    assert.equal(out.ok, true);
    assert.deepEqual(clock.waits, [7000]);
});

test('429 with a Retry-After HTTP date (plain object headers) waits until that date', async () => {
    const { limiter, clock } = fakeLimiter({});
    const date = new Date(clock.t + 12_000).toUTCString();
    let calls = 0;
    await limiter.withRateLimit({ key: 'k' }, async () => {
        calls += 1;
        if (calls === 1) throw rateErr(429, { 'retry-after': date });
        return {};
    });
    assert.equal(calls, 2);
    // The HTTP date has a one second resolution.
    assert.ok(clock.waits[0] >= 11_000 && clock.waits[0] <= 12_000, `waited ${clock.waits[0]}`);
});

test('a huge Retry-After is capped by LLM_RATE_LIMIT_MAX_WAIT_MS', async () => {
    const { limiter, clock } = fakeLimiter({ LLM_RATE_LIMIT_MAX_WAIT_MS: '5000' });
    let calls = 0;
    await limiter.withRateLimit({ key: 'k' }, async () => {
        calls += 1;
        if (calls === 1) throw rateErr(429, { 'retry-after': '86400' });
        return {};
    });
    assert.deepEqual(clock.waits, [5000]);
});

test('without Retry-After the backoff grows exponentially', async () => {
    const { limiter, clock } = fakeLimiter({});
    let calls = 0;
    await limiter.withRateLimit({ key: 'k' }, async () => {
        calls += 1;
        if (calls <= 3) throw rateErr(503);
        return {};
    });
    assert.equal(calls, 4);
    assert.equal(clock.waits.length, 3);
    // base 1000 ms * 2^attempt plus under 250 ms of jitter.
    assert.ok(clock.waits[0] >= 1000 && clock.waits[0] < 1250);
    assert.ok(clock.waits[1] >= 2000 && clock.waits[1] < 2250);
    assert.ok(clock.waits[2] >= 4000 && clock.waits[2] < 4250);
});

test('an overloaded error without a status is retried', async () => {
    const { limiter } = fakeLimiter({});
    let calls = 0;
    await limiter.withRateLimit({ key: 'k' }, async () => {
        calls += 1;
        if (calls === 1) throw new Error('Overloaded');
        return {};
    });
    assert.equal(calls, 2);
});

test('errors that are not rate limits are rethrown untouched and not retried', async () => {
    const { limiter, clock } = fakeLimiter({});
    const boom = rateErr(400);
    let calls = 0;
    await assert.rejects(limiter.withRateLimit({ key: 'k' }, async () => { calls += 1; throw boom; }), (e) => e === boom);
    assert.equal(calls, 1);
    assert.deepEqual(clock.waits, []);
});

test('LLM_RATE_LIMIT_RETRIES=0 turns the retry off', async () => {
    const { limiter } = fakeLimiter({ LLM_RATE_LIMIT_RETRIES: '0' });
    let calls = 0;
    await assert.rejects(limiter.withRateLimit({ key: 'k' }, async () => { calls += 1; throw rateErr(429); }), /429/);
    assert.equal(calls, 1);
});

test('retries are bounded: the last rate-limit error goes out', async () => {
    const { limiter } = fakeLimiter({ LLM_RATE_LIMIT_RETRIES: '2' });
    let calls = 0;
    await assert.rejects(limiter.withRateLimit({ key: 'k' }, async () => { calls += 1; throw rateErr(429, { 'retry-after': '1' }); }), /429/);
    assert.equal(calls, 3);
});

test('a cool-down after a 429 holds back other callers of the same key', async () => {
    const { limiter, clock } = fakeLimiter({});
    let first = true;
    const slow = limiter.withRateLimit({ key: 'k' }, async () => {
        if (first) { first = false; throw rateErr(429, { 'retry-after': '3' }); }
        return {};
    });
    await slow;
    const before = clock.t;
    await limiter.acquire('k');
    assert.equal(clock.t, before); // the pause is over: no extra wait
    assert.deepEqual(clock.waits, [3000]);
});

test('an aborted signal throws Run cancelled, before and during a wait', async () => {
    const { limiter } = fakeLimiter({ LLM_PROVIDER_RPM: '1', LLM_PROVIDER_TPM: '0' });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(limiter.acquire('k', { signal: ac.signal }), /Run cancelled/);

    const ac2 = new AbortController();
    const limiter2 = createProviderLimiter({
        now: () => 0,
        sleep: async () => { ac2.abort(); },
        env: { LLM_PROVIDER_RPM: '1', LLM_PROVIDER_TPM: '0' },
    });
    await limiter2.acquire('k');
    await assert.rejects(limiter2.acquire('k', { signal: ac2.signal }), /Run cancelled/);
});

test('an aborted waiter in the queue does not block the one behind it', async () => {
    const { limiter } = fakeLimiter({ LLM_PROVIDER_RPM: '1', LLM_PROVIDER_TPM: '0' });
    await limiter.acquire('k');
    const ac = new AbortController();
    const doomed = limiter.acquire('k', { signal: ac.signal });
    const next = limiter.acquire('k');
    ac.abort();
    await assert.rejects(doomed, /Run cancelled/);
    await next;
});

test('limiterKeyFor: same connection, same bucket; other key, other bucket; never the raw key', () => {
    const a = limiterKeyFor({ adapterName: 'openai', url: 'https://x.example/v1/', apiKey: 'sk-secret-1' });
    const b = limiterKeyFor({ adapterName: 'openai', url: 'https://x.example/v1', apiKey: 'sk-secret-1' });
    const c = limiterKeyFor({ adapterName: 'openai', url: 'https://x.example/v1', apiKey: 'sk-secret-2' });
    const d = limiterKeyFor({ adapterName: 'claude', url: 'https://x.example/v1', apiKey: 'sk-secret-1' });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.notEqual(a, d);
    assert.match(a, /^llm:[0-9a-f]{32}$/);
    assert.ok(!a.includes('sk-secret'));
});

test('limitedChat calls adapter.chat with the plain arguments and settles from usage', async () => {
    const { limiter } = fakeLimiter({});
    /** @type {unknown[][]} */
    const seen = [];
    const adapter = {
        name: 'stub',
        chat: async (/** @type {unknown[]} */ ...args) => { seen.push(args); return { content: 'hi', usage: { input_tokens: 1, output_tokens: 2 } }; },
    };
    const out = await limiter.limitedChat({
        adapter, cfg: { apiKey: 'k', url: 'u' }, modelId: 'm', messages: [{ role: 'user', content: 'x' }], options: { temperature: 0 },
    });
    assert.equal(out.content, 'hi');
    assert.deepEqual(seen[0], ['k', 'u', 'm', [{ role: 'user', content: 'x' }], { temperature: 0 }]);
});

test('estimateRequestTokens counts content, array content, tools and the answer room', () => {
    assert.equal(estimateRequestTokens([{ content: 'a'.repeat(400) }], {}), 100 + 1024);
    assert.equal(estimateRequestTokens([{ content: 'a'.repeat(400) }], { maxTokens: 50 }), 150);
    const withArray = estimateRequestTokens([{ content: [{ type: 'text', text: 'hello' }] }], { maxTokens: 0 });
    assert.ok(withArray > 1024);
    const withTools = estimateRequestTokens([], { maxTokens: 10, tools: [{ type: 'function', function: { name: 'x' } }] });
    assert.ok(withTools > 10);
});

test('estimateRequestTokens counts unserialisable content and tools as nothing instead of throwing', () => {
    const circular = {};
    circular.self = circular;
    assert.equal(estimateRequestTokens([{ content: circular }], { maxTokens: 10 }), 10);
    assert.equal(estimateRequestTokens([], { maxTokens: 10, tools: circular }), 10);
    assert.equal(estimateRequestTokens([{ content: 1n }], { maxTokens: 10 }), 10);
});

test('rateLimitInfo reads status, error type and retryAfterMs; other errors give null', () => {
    assert.equal(rateLimitInfo(new Error('nope')), null);
    assert.equal(rateLimitInfo(rateErr(500)), null);
    assert.deepEqual(rateLimitInfo(rateErr(529)), { status: 529, retryAfterMs: null });
    const typed = Object.assign(new Error('x'), { error: { type: 'overloaded_error' } });
    assert.deepEqual(rateLimitInfo(typed), { status: null, retryAfterMs: null });
    const viaMessage = rateLimitInfo(new Error('Mistral API error 429: slow down'));
    assert.equal(viaMessage?.status, 429);
    const viaMs = Object.assign(rateErr(429), { retryAfterMs: 1500 });
    assert.equal(rateLimitInfo(viaMs)?.retryAfterMs, 1500);
    const viaResponse = Object.assign(rateErr(429), { response: { headers: new Headers({ 'retry-after': '2' }) } });
    assert.equal(rateLimitInfo(viaResponse)?.retryAfterMs, 2000);
});
