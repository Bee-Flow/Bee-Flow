/**
 * The whole-scan deadline: a chat message can block on PII scanning for a
 * BOUNDED time, after which the covered prefix is returned through the
 * existing partial-result contract (input_too_large_partial → the actionable
 * "too large" copy → the caller's fail-open/closed policy).
 *
 * Before this bound, "slow" could never error: up to 40 windows × 90s each is
 * a theoretical hour of user-blocking latency in which nothing fails. The
 * incident that motivated all of the request shaping was exactly this shape —
 * 52,990 chars took 278s against a 90s-per-request timeout.
 *
 * The bound is now min(windows × PII_GUARD_WINDOW_BUDGET_MS,
 * PII_GUARD_SCAN_DEADLINE_MS): an allowance per window, and a ceiling on the
 * total. A flat deadline was really a size limit — at ~4ms/char no flat 60s
 * could ever finish a 6-window paste, so the same message failed at the same
 * offset every time while its six parts sent one at a time all passed.
 *
 * In its own file because both numbers are read from the environment at module
 * load: they must be set BEFORE piiDetection is required, which would poison
 * the other suites.
 *
 * Run: node --test server/core/piiDetection.deadline.test.js
 */

const assert = require('assert');
const { test, before, after, beforeEach } = require('node:test');
const http = require('http');

process.env.NODE_ENV = 'test';
// Per window, and the ceiling on the whole scan. Sized against the 400ms stub
// below so that a few windows fit inside the ceiling and thirty do not.
process.env.PII_GUARD_WINDOW_BUDGET_MS = '1000';
process.env.PII_GUARD_SCAN_DEADLINE_MS = '5000';

function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return resolved;
}

stub('../aiAgent', { getAIConfig: async () => ({ piiDetectionEnabled: true }) });
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
});

let requests = [];
let server;
// Stub latency per guard call. Only two tests are SIZED against it: the
// deadline test (30 windows x 400ms against the 5s ceiling, which is what
// makes the scan overrun) and the memo test (whose `elapsed < 2000` only
// bites at this latency). Every other async test here only has to finish
// comfortably inside the deadline, so they run against a 20ms guard rather
// than pay 400ms per window to prove nothing.
// Tests in a file run sequentially and beforeEach puts this back to FAST,
// so a test that needs SLOW sets it as its first statement.
const FAST_STUB_MS = 20;
const SLOW_STUB_MS = 400;
let stubDelayMs = FAST_STUB_MS;

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
            const parsed = JSON.parse(body);
            requests.push(parsed.text);
            await new Promise(r => setTimeout(r, stubDelayMs));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasPii: false, entities: [], degraded: false, degraded_reason: null }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

const pii = require('./piiDetection');

beforeEach(() => {
    stubDelayMs = FAST_STUB_MS;
    requests = [];
    pii._resetGuardCircuit();
    pii.invalidateGuardEndpointCache();
});

/**
 * Text of `chars` length whose every window is DISTINCT.
 *
 * `'a'.repeat(n)` is the wrong fixture now that windows are memoised: every
 * window of it is the same string, so a 30-window scan collapses into two
 * guard calls and finishes instantly. That is correct behaviour and a useless
 * test. Real text repeats blocks, not characters.
 */
function distinctText(chars) {
    let s = '';
    for (let i = 0; s.length < chars; i++) s += `[block ${i}] ${'x'.repeat(400)} `;
    return s.slice(0, chars);
}

test('a scan larger than the deadline returns a bounded partial fail-closed result', async () => {
    stubDelayMs = SLOW_STUB_MS;
    // 30 windows x 400ms stub latency ≈ 12s of guard time against a 5s
    // ceiling: the scan must stop early, not grind to completion.
    const text = distinctText(pii.MAX_REQUEST_CHARS * 30);
    const t0 = Date.now();
    const result = await pii.detectPii(text, ['Email'], 0.7);
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 9000, `scan took ${elapsed}ms — the deadline did not bound it`);
    assert.ok(requests.length < 30, 'every window was scanned; the deadline never fired');
    assert.ok(result.degraded, 'a partial scan must be degraded — the tail is unscanned');
    assert.strictEqual(result.degradedReason, 'input_too_large_partial',
        'the existing partial contract must carry this, so classifyDegradation renders the too_large copy');
    assert.ok(result.processedChars > 0, 'the covered prefix must be reported');
    assert.ok(result.processedChars < text.length, 'coverage must not claim the unscanned tail');
    assert.strictEqual(pii.classifyDegradation(result.degradedReason), 'too_large',
        'the user should be told to split the message, not to retry the identical scan');
});

test('a scan comfortably inside the deadline is untouched by it', async () => {
    const text = distinctText(pii.MAX_REQUEST_CHARS * 2);
    const result = await pii.detectPii(text, ['Email'], 0.7);
    assert.ok(!result.degraded, 'nothing about a small scan should degrade');
});

test('the budget scales with the window count, up to the ceiling', () => {
    // 1000ms per window, 5000ms ceiling — the two env values set above.
    assert.strictEqual(pii.scanBudgetMs(1), 1000, 'a one-window scan gets one window of time');
    assert.strictEqual(pii.scanBudgetMs(4), 4000, 'four windows get four windows of time');
    assert.strictEqual(pii.scanBudgetMs(40), 5000, 'the ceiling still bounds the worst case');
    // The regression this whole change is about: a multi-window paste must not
    // be held to a ONE-window allowance. That is what turned an affordable
    // 6-window scan into "this message is too large to scan".
    assert.ok(pii.scanBudgetMs(6) > pii.scanBudgetMs(1),
        'six windows must be given more time than one, or size becomes the real limit');
});

test('a scan resumes from its already-scanned windows instead of re-paying for them', async () => {
    stubDelayMs = SLOW_STUB_MS; // `elapsed < 2000` below is sized against it
    // Four distinct windows, comfortably inside the ceiling, so the first
    // attempt completes and memoises each one.
    const text = distinctText(pii.MAX_REQUEST_CHARS * 3);
    const windows = pii.windowCountFor(text);
    await pii.detectPii(text, ['Email'], 0.7);
    assert.strictEqual(requests.length, windows, 'first pass scans every window once');

    // Text that SHARES those windows must not re-pay for them. Without the
    // per-window memo, a paste that ran out of budget at window 4 re-scanned
    // windows 1-4 on every retry and died in exactly the same place, forever.
    requests = [];
    const longer = text + distinctText(pii.MAX_REQUEST_CHARS).split('').reverse().join('');
    const t0 = Date.now();
    const result = await pii.detectPii(longer, ['Email'], 0.7);
    const elapsed = Date.now() - t0;

    assert.ok(requests.length < windows,
        `retry re-scanned ${requests.length}/${windows} known windows; they should have been reused`);
    assert.ok(elapsed < 2000, `retry took ${elapsed}ms — memoised windows were not free`);
    assert.ok(!result.degraded, 'reusing memoised windows must still produce a complete scan');
});

test('progress is reported once per window so a caller can show where it is', async () => {
    const text = distinctText(pii.MAX_REQUEST_CHARS * 3);
    const total = pii.windowCountFor(text);
    const seen = [];
    const result = await pii.detectPii(text, ['Email'], 0.7, {
        onProgress: (p) => seen.push(p),
    });
    assert.ok(!result.degraded);
    assert.strictEqual(seen.length, total, 'one progress event per window');
    assert.deepStrictEqual(seen.map(p => p.done), seen.map((_, i) => i + 1), 'monotonic, 1-based');
    assert.ok(seen.every(p => p.total === total), 'every event carries the total');
    assert.strictEqual(seen.at(-1).totalChars, text.length);
    assert.strictEqual(seen.at(-1).coveredChars, text.length, 'the last event covers the whole text');
});

test('a progress handler that throws cannot take the scan down with it', async () => {
    const text = distinctText(pii.MAX_REQUEST_CHARS * 2);
    const result = await pii.detectPii(text, ['Email'], 0.7, {
        onProgress: () => { throw new Error('caller bug'); },
    });
    assert.ok(!result.degraded, 'a broken status line must not fail a privacy scan');
});

test('_contiguousCoverage never claims coverage across a gap', () => {
    const W = 1000;
    const part = (start, len) => ({ start, result: { processedChars: len, redactedText: '' } });
    // Windows 0 and 2 finished; window 1 (starting at 1000) never did. Claiming
    // 3000 would pass window 1's unscanned text off as clean — the exact leak
    // the partial contract exists to prevent.
    assert.strictEqual(pii._contiguousCoverage([part(0, W), part(2000, W)], 99999), W);
    // In-order completion reports full coverage.
    assert.strictEqual(pii._contiguousCoverage([part(0, W), part(1000, W), part(2000, W)], 99999), 3000);
    // Overlapping windows (the 256-char overlap) extend, not reset.
    assert.strictEqual(pii._contiguousCoverage([part(0, W), part(744, W)], 99999), 1744);
    assert.strictEqual(pii._contiguousCoverage([], 5), 0);
});
