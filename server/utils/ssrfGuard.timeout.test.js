'use strict';
/**
 * safeFetch is bounded by the outbound default time-out.
 * The guarded dispatcher refuses loopback, so the test hands safeFetch an
 * Agent that resolves a public-looking name to a local server that never
 * answers. Run: node --test utils/ssrfGuard.timeout.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Agent } = require('undici');
const { safeFetch } = require('./ssrfGuard');

async function silentServer() {
    const srv = http.createServer((req, res) => {
        if (req.url === '/late') setTimeout(() => res.end('late'), 150);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
    const dispatcher = new Agent({
        connect: {
            lookup: /** @type {any} */ ((/** @type {string} */ _host, /** @type {any} */ options, /** @type {Function} */ cb) => (
                options && options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)
            )),
        },
    });
    return {
        url: (/** @type {string} */ path) => `http://never-answers.example:${port}${path}`,
        dispatcher,
        close: async () => { srv.closeAllConnections(); srv.close(); await dispatcher.close(); },
    };
}

/** @param {string | undefined} value @param {() => Promise<void>} fn */
async function withEnv(value, fn) {
    const saved = process.env.OUTBOUND_HTTP_TIMEOUT_MS;
    if (value === undefined) delete process.env.OUTBOUND_HTTP_TIMEOUT_MS; else process.env.OUTBOUND_HTTP_TIMEOUT_MS = value;
    try { await fn(); } finally {
        if (saved === undefined) delete process.env.OUTBOUND_HTTP_TIMEOUT_MS; else process.env.OUTBOUND_HTTP_TIMEOUT_MS = saved;
    }
}

test('safeFetch gives up on a server that never answers after OUTBOUND_HTTP_TIMEOUT_MS', async () => {
    const srv = await silentServer();
    try {
        await withEnv('100', async () => {
            await assert.rejects(safeFetch(srv.url('/never'), { dispatcher: srv.dispatcher }), { name: 'TimeoutError' });
        });
    } finally { await srv.close(); }
});

test('safeFetch: a caller signal still aborts, a caller timeoutMs replaces the default, 0 turns it off', async () => {
    const srv = await silentServer();
    try {
        await withEnv('50', async () => {
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 30);
            await assert.rejects(safeFetch(srv.url('/never'), { dispatcher: srv.dispatcher, signal: ctrl.signal }), { name: 'AbortError' });
            await assert.rejects(safeFetch(srv.url('/late'), { dispatcher: srv.dispatcher }), { name: 'TimeoutError' });
            const res = await safeFetch(srv.url('/late'), { dispatcher: srv.dispatcher, timeoutMs: 5000 });
            assert.equal(await res.text(), 'late');
        });
        await withEnv('0', async () => {
            const res = await safeFetch(srv.url('/late'), { dispatcher: srv.dispatcher });
            assert.equal(await res.text(), 'late');
        });
    } finally { await srv.close(); }
});
