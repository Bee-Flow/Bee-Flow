/**
 * Windows, the in-flight gate, and the breaker.
 *
 * BFSF-322 is the ticket for the user-visible half of this: "message send fails
 * intermittently with 'Privacy protection is temporarily unavailable'", with the
 * reporter noting it happened on large pastes and not on small ones. That is
 * the SIZE cause below, and these tests are what keep it fixed.
 *
 * These three exist because of one production failure: intermittent
 * "Privacy protection is temporarily unavailable, so your message was not sent"
 * after a bulk paste. Three scans in 48h ran past the 90s HTTP timeout — 52,990
 * chars took 278s — and a timeout is reported as `guard_unreachable`, which a
 * fail-closed org turns into a blocked message. The guard was healthy; the
 * request was just bigger than the deadline.
 *
 * What is pinned here:
 *   * no single request can exceed the window budget, so the deadline stops
 *     being reachable by size alone;
 *   * a windowed scan finds entities in EVERY window and reports offsets in the
 *     original text — the failure mode of a naive fix is offsets relative to the
 *     window, which tokenizeText then splices at the wrong place (that is a
 *     corruption bug, not a detection bug);
 *   * in-flight calls are bounded, because the two local fan-outs
 *     (attachmentScanner 3 lanes, chatStream tool scan 3 lanes) had nothing
 *     above them and queued inside the guard where this client is blind;
 *   * a known-bad guard answers immediately instead of costing another 90s.
 *
 * Run: node --test server/core/piiDetection.requestshaping.test.js
 */

const assert = require('assert');
const { test, before, after, beforeEach } = require('node:test');
const http = require('http');

process.env.NODE_ENV = 'test';

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

// Guard behaviour is switched per test.
let mode = 'ok';
let requests = [];          // one entry per /pii call
let concurrent = 0;
let maxConcurrent = 0;
let server;

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
            const parsed = JSON.parse(body);
            requests.push(parsed.text);
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            // Hold the connection open briefly so overlap is observable.
            await new Promise(r => setTimeout(r, 25));
            concurrent -= 1;

            if (mode === 'error') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end('{"detail":"boom"}');
                return;
            }
            // Report the marker's position WITHIN this window — the guard only
            // ever sees the window, which is exactly why offsets must be
            // translated on the way back.
            const idx = parsed.text.indexOf('jan@voorbeeld.nl');
            const entities = idx === -1 ? [] : [{
                text: 'jan@voorbeeld.nl',
                category: 'Email',
                confidence: 0.95,
                offset: idx,
                length: 'jan@voorbeeld.nl'.length,
                label: 'Email Address',
            }];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                hasPii: entities.length > 0,
                entities,
                degraded: false,
                degraded_reason: null,
            }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

const pii = require('./piiDetection');

beforeEach(() => {
    mode = 'ok';
    requests = [];
    concurrent = 0;
    maxConcurrent = 0;
    pii._resetGuardCircuit();
    pii.invalidateGuardEndpointCache();
});

/** Text of `len` chars with `jan@voorbeeld.nl` planted at `at`. */
function textWithEmailAt(len, at) {
    const filler = 'x'.repeat(len);
    return filler.slice(0, at) + 'jan@voorbeeld.nl' + filler.slice(at + 16);
}

test('no single guard request exceeds the window budget', async () => {
    const big = 'a'.repeat(pii.MAX_REQUEST_CHARS * 3 + 500);
    await pii.detectPii(big, ['Email'], 0.7);
    assert.ok(requests.length > 1, 'expected the scan to be split');
    for (const sent of requests) {
        assert.ok(
            sent.length <= pii.MAX_REQUEST_CHARS,
            `a window of ${sent.length} chars exceeded the ${pii.MAX_REQUEST_CHARS} budget — ` +
            'this is the size that used to blow the 90s timeout',
        );
    }
});

test('an entity in a later window is reported at its offset in the ORIGINAL text', async () => {
    // Deep into the third window, so a window-relative offset would be wrong by
    // roughly two whole windows.
    const at = pii.MAX_REQUEST_CHARS * 2 + 1000;
    const text = textWithEmailAt(pii.MAX_REQUEST_CHARS * 3, at);
    const result = await pii.detectPii(text, ['Email'], 0.7);
    assert.ok(result.hasPii, 'the email in window 3 was not found at all');
    const hit = result.entities.find(e => e.category === 'Email');
    assert.strictEqual(
        text.slice(hit.offset, hit.offset + hit.length), 'jan@voorbeeld.nl',
        'the reported offset does not slice back to the entity — tokenizeText ' +
        'would splice the wrong characters and leave the real PII in place',
    );
});

test('an entity is reported once, not once per overlapping window', async () => {
    // Sitting in the overlap region between window 1 and window 2.
    const at = pii.MAX_REQUEST_CHARS - 100;
    const text = textWithEmailAt(pii.MAX_REQUEST_CHARS * 2, at);
    const result = await pii.detectPii(text, ['Email'], 0.7);
    const hits = result.entities.filter(e => e.category === 'Email');
    assert.strictEqual(hits.length, 1, `overlap produced ${hits.length} copies`);
});

test('windows are scanned sequentially, never fanned out', async () => {
    const big = 'a'.repeat(pii.MAX_REQUEST_CHARS * 3);
    await pii.detectPii(big, ['Email'], 0.7);
    assert.strictEqual(
        maxConcurrent, 1,
        'one user\'s paste fanned out into concurrent guard calls — the exact ' +
        'shape that made bulk pastes the trigger',
    );
});

test('concurrent callers are bounded, not unleashed on the guard', async () => {
    // Six DISTINCT scans at once — what two attachment scans look like today.
    // (Distinct texts on purpose: identical ones are coalesced by the
    // single-flight table, which the tests below pin separately.)
    await Promise.all(Array.from({ length: 6 }, (_, i) => pii.detectPii(`hallo daar ${i}`, ['Email'], 0.7)));
    assert.ok(
        maxConcurrent <= 2,
        `${maxConcurrent} concurrent guard calls got through a limit of 2`,
    );
    assert.strictEqual(requests.length, 6, 'a caller was dropped rather than queued');
});

test('a small scan still takes exactly one request', async () => {
    await pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email'], 0.7);
    assert.strictEqual(requests.length, 1);
});

// ── Cache + single-flight ────────────────────────────────────────────
// detectPii() is now the caching layer for EVERY caller. Before this, only
// validateInput/OutputForPii cached — the DLP chat path (the one on
// time-to-first-token) re-paid a full guard round trip for every identical
// scan, and three users retrying the same failing paste tripled the load at
// the worst moment (the REPEAT COST note above).

test('identical concurrent scans are coalesced into one guard call', async () => {
    const results = await Promise.all(
        Array.from({ length: 6 }, () => pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email'], 0.7)),
    );
    assert.strictEqual(requests.length, 1, 'six identical in-flight scans should share one request');
    for (const r of results) {
        assert.ok(r.hasPii, 'every joiner receives the shared result');
        assert.strictEqual(r.entities[0].category, 'Email');
    }
});

test('an identical scan within the TTL is served from cache', async () => {
    await pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email'], 0.7);
    const again = await pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email'], 0.7);
    assert.strictEqual(requests.length, 1, 'the second scan should not reach the guard');
    assert.ok(again.hasPii);
});

test('a different threshold or category set is a different cache entry', async () => {
    await pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email'], 0.7);
    await pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email'], 0.8);
    await pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email', 'Person'], 0.7);
    assert.strictEqual(requests.length, 3, 'threshold/categories must partition the cache — ' +
        'an admin moving the slider must take effect, not be absorbed');
});

test('degraded results are never cached — a retry gets a fresh scan', async () => {
    mode = 'error';
    const first = await pii.detectPii('hallo daar', ['Email'], 0.7);
    assert.ok(first.degraded);
    // ONE failure does not open the breaker (threshold 3), so a fresh scan is
    // only possible if the degraded result was genuinely not cached. No state
    // reset here — that would mask exactly the semantics under test.
    mode = 'ok';
    const second = await pii.detectPii('hallo daar', ['Email'], 0.7);
    assert.ok(!second.degraded, 'the recovered guard should be consulted, not the failure replayed');
    assert.strictEqual(requests.length, 2, 'the retry must reach the guard');
});

test('a caller mutating its result cannot corrupt the cache', async () => {
    const first = await pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email'], 0.7);
    // tokenizeText and dlpRunner annotate/splice entity objects in place.
    first.entities[0].offset = 999999;
    first.entities.length = 0;
    const second = await pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email'], 0.7);
    assert.strictEqual(requests.length, 1, 'still a cache hit');
    assert.strictEqual(second.entities.length, 1, 'the cached copy must be pristine');
    assert.notStrictEqual(second.entities[0].offset, 999999);
});

test('a repeatedly failing guard is short-circuited instead of re-timed-out', async () => {
    mode = 'error';
    for (let i = 0; i < 3; i++) {
        const r = await pii.detectPii('hallo daar', ['Email'], 0.7);
        assert.ok(r.degraded);
    }
    const before = requests.length;
    const shortCircuited = await pii.detectPii('hallo daar', ['Email'], 0.7);
    assert.strictEqual(requests.length, before, 'the breaker let a call through');
    assert.ok(shortCircuited.degraded, 'short-circuiting must stay degraded — the ' +
        'caller\'s fail-open/closed policy is not ours to change');
    assert.strictEqual(shortCircuited.degradedReason, 'guard_circuit_open');
});

test('a recovered guard closes the breaker', async () => {
    mode = 'error';
    for (let i = 0; i < 3; i++) {
        await pii.detectPii('hallo daar', ['Email'], 0.7);
    }
    assert.strictEqual((await pii.detectPii('x y z', ['Email'], 0.7)).degradedReason, 'guard_circuit_open');
    // Half-open: the cooldown expiring must let a probe through.
    pii._resetGuardCircuit();
    mode = 'ok';
    const healthy = await pii.detectPii('mail mij op jan@voorbeeld.nl', ['Email'], 0.7);
    assert.ok(!healthy.degraded);
    assert.ok(healthy.hasPii);
});

test('a window that errors aborts the scan rather than reporting a clean prefix', async () => {
    mode = 'error';
    const big = 'a'.repeat(pii.MAX_REQUEST_CHARS * 3);
    const result = await pii.detectPii(big, ['Email'], 0.7);
    assert.ok(result.degraded, 'a partly-failed windowed scan reported success');
    assert.ok(/guard_unreachable/.test(result.degradedReason));
    // And it did not grind through the remaining windows to find that out.
    assert.strictEqual(requests.length, 1);
});

test('text beyond the maximum window count is reported as partial, not clean', () => {
    // windowText caps coverage; the merge must then declare partial coverage so
    // a coverage-aware caller fails closed on the tail instead of trusting it.
    const huge = 'a'.repeat(pii.MAX_REQUEST_CHARS * 60);
    const windows = pii.windowText(huge);
    const covered = windows[windows.length - 1][0] + windows[windows.length - 1][1].length;
    assert.ok(covered < huge.length, 'expected the window cap to leave a tail');
    const merged = pii.mergeWindowResults(
        huge,
        windows.map(([start, _chunk]) => ({ start, result: { entities: [], degraded: false } })),
        covered,
    );
    assert.ok(merged.degraded);
    assert.strictEqual(merged.degradedReason, 'input_too_large_partial');
    assert.strictEqual(merged.totalChars, huge.length);
    assert.ok(merged.processedChars < merged.totalChars);
    assert.strictEqual(
        merged.degradedCategories, null,
        'an unscanned tail can hide any category — claiming a narrow scope here ' +
        'would let the scope-intersection check wave the message through',
    );
});

test('one window with an unknown degraded scope poisons the merged scope', () => {
    const merged = pii.mergeWindowResults('abc', [
        { start: 0, result: { entities: [], degraded: true, degradedCategories: ['Email'] } },
        { start: 0, result: { entities: [], degraded: true, degradedCategories: null } },
    ], 3);
    assert.strictEqual(
        merged.degradedCategories, null,
        'narrowing to the categories the other windows named would claim ' +
        'coverage we do not have',
    );
});

test('degradation reasons are classified so the advice can differ', () => {
    assert.strictEqual(pii.classifyDegradation('input_too_large'), 'too_large');
    assert.strictEqual(pii.classifyDegradation('input_too_large_partial'), 'too_large');
    assert.strictEqual(pii.classifyDegradation('guard_unreachable: guard-service /pii timeout'), 'timeout');
    assert.strictEqual(pii.classifyDegradation('gliner_group_failed:Email,Person'), 'unavailable');
    assert.strictEqual(pii.classifyDegradation('guard_circuit_open'), 'unavailable');
    assert.strictEqual(pii.classifyDegradation(null), 'unavailable');
});
