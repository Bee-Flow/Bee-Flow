'use strict';
/** fetchFixedEndpoint against a local server. Run: node --test core/http/fixedEndpointFetch.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchFixedEndpoint } = require('./fixedEndpointFetch.mts');

/**
 * A server that answers `/slow-body` with headers at once and the body after
 * 800 ms, `/late` after 150 ms, and never answers anything else.
 */
async function localServer() {
    const srv = http.createServer((req, res) => {
        if (req.url === '/slow-body') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.flushHeaders();
            setTimeout(() => res.end('done'), 800);
        } else if (req.url === '/late') {
            setTimeout(() => res.end('late'), 150);
        }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
    return { base: `http://127.0.0.1:${port}`, close: () => { srv.closeAllConnections(); srv.close(); } };
}

/** @param {string | undefined} value @param {() => Promise<void>} fn */
async function withEnv(value, fn) {
    const saved = process.env.OUTBOUND_HTTP_TIMEOUT_MS;
    if (value === undefined) delete process.env.OUTBOUND_HTTP_TIMEOUT_MS; else process.env.OUTBOUND_HTTP_TIMEOUT_MS = value;
    try { await fn(); } finally {
        if (saved === undefined) delete process.env.OUTBOUND_HTTP_TIMEOUT_MS; else process.env.OUTBOUND_HTTP_TIMEOUT_MS = saved;
    }
}

test('a server that never answers is cut off by OUTBOUND_HTTP_TIMEOUT_MS', async () => {
    const srv = await localServer();
    try {
        await withEnv('100', async () => {
            const started = Date.now();
            await assert.rejects(fetchFixedEndpoint(`${srv.base}/never`), { name: 'TimeoutError' });
            assert.ok(Date.now() - started < 5000);
        });
    } finally { srv.close(); }
});

test('a caller signal still aborts the call', async () => {
    const srv = await localServer();
    try {
        await withEnv(undefined, async () => {
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 50);
            await assert.rejects(fetchFixedEndpoint(`${srv.base}/never`, { signal: ctrl.signal }), { name: 'AbortError' });
        });
    } finally { srv.close(); }
});

test('0 turns the default off, a caller timeoutMs replaces it', async () => {
    const srv = await localServer();
    try {
        await withEnv('50', async () => {
            await assert.rejects(fetchFixedEndpoint(`${srv.base}/late`), { name: 'TimeoutError' });
            const res = await fetchFixedEndpoint(`${srv.base}/late`, { timeoutMs: 5000 });
            assert.equal(await res.text(), 'late');
        });
        await withEnv('0', async () => {
            const res = await fetchFixedEndpoint(`${srv.base}/late`);
            assert.equal(await res.text(), 'late');
        });
    } finally { srv.close(); }
});

test('the headers phase lets a slow body finish; the total phase does not', async () => {
    const srv = await localServer();
    try {
        await withEnv(undefined, async () => {
            const streamed = await fetchFixedEndpoint(`${srv.base}/slow-body`, { timeoutMs: 400, timeoutPhase: 'headers' });
            assert.equal(await streamed.text(), 'done');
            const bounded = await fetchFixedEndpoint(`${srv.base}/slow-body`, { timeoutMs: 400 });
            await assert.rejects(bounded.text(), { name: 'TimeoutError' });
        });
    } finally { srv.close(); }
});
