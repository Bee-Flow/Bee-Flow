'use strict';
/** The outbound default time-out rule. Run: node --test core/http/outboundTimeout.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { outboundTimeoutMs, effectiveTimeoutMs, fetchWithTimeout, defaultTimeoutSignal, DEFAULT_OUTBOUND_TIMEOUT_MS } = require('./outboundTimeout.mts');

/** A fetch stand-in that only settles when its signal aborts (or after `answerAfterMs`). */
function pendingFetch({ answerAfterMs = Infinity } = {}) {
    const seen = [];
    const impl = (_url, init) => new Promise((resolve, reject) => {
        seen.push(init);
        // The abort timers are unref'd; this keeps the test process alive until the call settles.
        const keepAlive = setTimeout(() => reject(new Error('never settled')), 5000);
        const settle = (fn, value) => { clearTimeout(keepAlive); fn(value); };
        const signal = init.signal;
        if (signal) signal.addEventListener('abort', () => settle(reject, signal.reason), { once: true });
        if (Number.isFinite(answerAfterMs)) setTimeout(() => settle(resolve, { ok: true, init }), answerAfterMs);
    });
    return { impl, seen };
}

test('OUTBOUND_HTTP_TIMEOUT_MS is read; unset, empty, negative or not a number give the default; 0 stays 0', () => {
    assert.equal(outboundTimeoutMs({}), DEFAULT_OUTBOUND_TIMEOUT_MS);
    assert.equal(DEFAULT_OUTBOUND_TIMEOUT_MS, 30_000);
    assert.equal(outboundTimeoutMs({ OUTBOUND_HTTP_TIMEOUT_MS: '5000' }), 5000);
    assert.equal(outboundTimeoutMs({ OUTBOUND_HTTP_TIMEOUT_MS: '0' }), 0);
    assert.equal(outboundTimeoutMs({ OUTBOUND_HTTP_TIMEOUT_MS: '' }), DEFAULT_OUTBOUND_TIMEOUT_MS);
    assert.equal(outboundTimeoutMs({ OUTBOUND_HTTP_TIMEOUT_MS: 'soon' }), DEFAULT_OUTBOUND_TIMEOUT_MS);
    assert.equal(outboundTimeoutMs({ OUTBOUND_HTTP_TIMEOUT_MS: '-1' }), DEFAULT_OUTBOUND_TIMEOUT_MS);
});

test('defaultTimeoutSignal fires after the configured time and is absent at 0', async () => {
    assert.equal(defaultTimeoutSignal({ OUTBOUND_HTTP_TIMEOUT_MS: '0' }), undefined);
    const signal = defaultTimeoutSignal({ OUTBOUND_HTTP_TIMEOUT_MS: '20' });
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, 'TimeoutError');
});

test('a caller timeoutMs wins over the default, a caller signal means the caller owns the lifetime', () => {
    const env = { OUTBOUND_HTTP_TIMEOUT_MS: '5000' };
    assert.equal(effectiveTimeoutMs({}, env), 5000);
    assert.equal(effectiveTimeoutMs({ timeoutMs: 120_000 }, env), 120_000);
    assert.equal(effectiveTimeoutMs({ timeoutMs: 0 }, env), 0);
    assert.equal(effectiveTimeoutMs({ signal: new AbortController().signal }, env), 0);
    assert.equal(effectiveTimeoutMs({ signal: new AbortController().signal, timeoutMs: 100 }, env), 100);
});

test('the default fires as a TimeoutError and the option keys never reach the fetch', async () => {
    const { impl, seen } = pendingFetch();
    await assert.rejects(fetchWithTimeout(impl, 'http://x/', { method: 'POST', timeoutPhase: 'total' }, { OUTBOUND_HTTP_TIMEOUT_MS: '30' }), { name: 'TimeoutError' });
    assert.equal(seen[0].method, 'POST');
    assert.equal('timeoutMs' in seen[0], false);
    assert.equal('timeoutPhase' in seen[0], false);
});

test('0 in the environment adds no signal at all', async () => {
    const { impl, seen } = pendingFetch({ answerAfterMs: 40 });
    const res = await fetchWithTimeout(impl, 'http://x/', {}, { OUTBOUND_HTTP_TIMEOUT_MS: '0' });
    assert.equal(res.ok, true);
    assert.equal(seen[0].signal, undefined);
});

test('a caller signal still aborts when combined with a caller timeoutMs', async () => {
    const { impl } = pendingFetch();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('caller stopped')), 20);
    await assert.rejects(fetchWithTimeout(impl, 'http://x/', { signal: ctrl.signal, timeoutMs: 60_000 }, {}), /caller stopped/);
});

test('the headers phase stops counting once the response is there', async () => {
    const { impl, seen } = pendingFetch({ answerAfterMs: 5 });
    await fetchWithTimeout(impl, 'http://x/', { timeoutMs: 30, timeoutPhase: 'headers' }, {});
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(seen[0].signal.aborted, false);
});
