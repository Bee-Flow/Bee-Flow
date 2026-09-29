/**
 * The caller's own AbortSignal — the chat routes' "the user pressed stop".
 *
 * `timeoutMs` (base.test.js) is the watchdog for a stalled connection. This is
 * the other one: a signal the ROUTE owns, aborted when the browser closes the
 * SSE response. Until 2026-09-16 the direct-chat, webpage-chat and
 * template-chat routes passed none, so a cancelled answer kept generating —
 * on a single-slot local llama.cpp that meant the next message waited for the
 * answer nobody wanted. The adapter side has to hold up its end: the signal
 * must reach fetch whether or not a watchdog is also armed.
 *
 * Pure + network-free (global.fetch stubbed).
 * Run: cd server && node --test core/providers/base.clientAbort.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const BaseProvider = require('./base');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

/** A fetch that never answers — only an abort can end it (undici semantics). */
function hangingFetch(seen) {
    return (url, opts) => new Promise((resolve, reject) => {
        seen.signal = opts.signal;
        opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
}

test('stream: the caller signal alone reaches fetch and ends the request', async () => {
    const seen = {};
    global.fetch = hangingFetch(seen);
    const ac = new AbortController();
    const provider = new BaseProvider('generic');

    const p = provider.stream('key', 'https://llm.example/v1', 'model-x', [{ role: 'user', content: 'hi' }], { signal: ac.signal }, () => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(seen.signal, 'the request carries a signal');
    ac.abort();
    await assert.rejects(() => p, (e) => e.name === 'AbortError');
});

test('stream: caller signal and watchdog both live — the caller wins immediately', async () => {
    const seen = {};
    global.fetch = hangingFetch(seen);
    const ac = new AbortController();
    const provider = new BaseProvider('generic');

    const started = Date.now();
    const p = provider.stream('key', 'https://llm.example/v1', 'model-x', [{ role: 'user', content: 'hi' }],
        { signal: ac.signal, timeoutMs: 60000 }, () => {});
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await assert.rejects(() => p);
    assert.ok(Date.now() - started < 2000, 'the stop does not wait for the watchdog');
});

test('chat: the caller signal is honoured there too — a tool pre-check is cancellable', async () => {
    const seen = {};
    global.fetch = hangingFetch(seen);
    const ac = new AbortController();
    const provider = new BaseProvider('generic');

    const p = provider.chat('key', 'https://llm.example/v1', 'model-x', [{ role: 'user', content: 'hi' }], { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await assert.rejects(() => p);
});

test('a signal aborted before the call yields no tokens at all', async () => {
    // undici rejects on an already-aborted signal instead of sending; the stub
    // models that, and the point under test is that the adapter passes the
    // signal on rather than starting a stream the user already cancelled.
    global.fetch = async (url, opts) => {
        if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return { ok: true, body: (async function* () { yield Buffer.from('data: [DONE]\n\n'); })() };
    };
    const ac = new AbortController();
    ac.abort();
    const provider = new BaseProvider('generic');
    const events = [];

    await assert.rejects(
        () => provider.stream('key', 'https://llm.example/v1', 'model-x', [{ role: 'user', content: 'hi' }], { signal: ac.signal }, (type) => events.push(type)),
        (e) => e.name === 'AbortError',
    );
    assert.deepStrictEqual(events, [], 'nothing reaches the client after stop');
});

test('no signal and no timeout: the request shape is unchanged', async () => {
    let sawSignal = 'unset';
    global.fetch = async (url, opts) => {
        sawSignal = opts.signal;
        return { ok: true, body: (async function* () { yield Buffer.from('data: [DONE]\n\n'); })() };
    };
    const provider = new BaseProvider('generic');
    await provider.stream('key', 'https://llm.example/v1', 'model-x', [{ role: 'user', content: 'hi' }], {}, () => {});
    assert.strictEqual(sawSignal, undefined, 'callers that pass neither get no signal');
});
