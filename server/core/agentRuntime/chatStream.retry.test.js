/**
 * Tests for the stream retry helpers in chatStream.js.
 *
 * Run: node --test core/agentRuntime/chatStream.retry.test.js
 *
 * The full streaming path needs a provider adapter + SSE plumbing, so these
 * tests target the extracted streamRetry helpers plus the accumulator-reset
 * contract: a retried closure must start from clean per-attempt state, or a
 * stream that emitted tool_use frames before dropping executes them twice.
 */

const test = require('node:test');
const assert = require('assert');
const { classifyStreamError, retryStreamCall } = require('./streamRetry');

test('classifyStreamError matrix', () => {
    const cases = [
        [new TypeError('fetch failed ECONNRESET'), true, 'network'],
        [Object.assign(new Error('x'), { name: 'TimeoutError' }), true, 'timeout'],
        [new Error('request timed out'), true, 'timeout'],
        [new Error('overloaded_error from provider'), true, 'overloaded'],
        [Object.assign(new Error('x'), { status: 529 }), true, 'overloaded'],
        [new Error('API error 429 rate limited'), true, 'rate_limit'],
        [new Error('API error 503 unavailable'), true, 'server'],
        [Object.assign(new Error('boom'), { status: 500 }), true, 'server'],
        [new Error('API error 400 bad request'), false, 'bad_request'],
        [Object.assign(new Error('x'), { status: 401 }), false, 'auth'],
        [Object.assign(new Error('x'), { status: 413 }), false, 'payload_too_large'],
        [new Error('maximum context length exceeded'), false, 'context_overflow'],
        [new Error('something odd'), false, 'unknown'],
    ];
    for (const [err, retryable, errorType] of cases) {
        const c = classifyStreamError(err);
        assert.strictEqual(c.retryable, retryable, `${err.message} retryable=${retryable}`);
        assert.strictEqual(c.errorType, errorType, `${err.message} type=${errorType}`);
    }
});

test('retryStreamCall re-invokes the closure; per-attempt reset leaves exactly one accumulation', async () => {
    // Shaped like the real call site: the accumulators live OUTSIDE the
    // closure, the closure resets them on entry, the "stream" emits a tool
    // call and then dies on attempt 1 with a retryable error.
    let toolCalls = [];
    let attempts = 0;

    await retryStreamCall(() => {
        toolCalls = []; // per-attempt reset (the fix under test)
        attempts++;
        toolCalls.push({ function: { name: 'youtrack_create_issue', arguments: '{}' } });
        if (attempts === 1) throw new Error('API error 503 stream dropped');
        return Promise.resolve();
    }, 3, null);

    assert.strictEqual(attempts, 2);
    assert.strictEqual(toolCalls.length, 1, 'reset prevented double accumulation');
});

test('without the per-attempt reset the same scenario duplicates the tool call (regression shape)', async () => {
    // Documents the pre-fix failure mode so the reset is never "simplified" away.
    const toolCalls = [];
    let attempts = 0;

    await retryStreamCall(() => {
        attempts++;
        toolCalls.push({ function: { name: 'youtrack_create_issue', arguments: '{}' } });
        if (attempts === 1) throw new Error('API error 503 stream dropped');
        return Promise.resolve();
    }, 3, null);

    assert.strictEqual(toolCalls.length, 2, 'no reset → duplicate tool call (the original bug)');
});

test('retryStreamCall does not retry permanent errors', async () => {
    let attempts = 0;
    await assert.rejects(
        retryStreamCall(() => {
            attempts++;
            throw new Error('API error 400 bad request');
        }, 3, null),
        /API error 400/
    );
    assert.strictEqual(attempts, 1);
});

test('retryStreamCall bails immediately on an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    await assert.rejects(
        retryStreamCall(() => { attempts++; return Promise.resolve(); }, 3, controller.signal),
        /aborted/i
    );
    assert.strictEqual(attempts, 0);
});
