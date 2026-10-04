/**
 * guardClient.httpPost — the keep-alive retry (BFSF-373).
 *
 * An automation step failed with "guard_unreachable: socket hang up" because a
 * pooled keep-alive socket was reused at the moment the guard closed it. The
 * client now retries exactly once when a request dies on a REUSED socket
 * before any response, and never otherwise: a reset on a fresh socket means
 * the guard itself is in trouble, and retry load would only add to it.
 *
 * A local HTTP server plays the guard and decides per request whether to
 * answer or to destroy the socket, so each case is deterministic.
 *
 * Run: cd server && node --test core/privacy/piiDetection/guardClient.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { httpPost } = require('./guardClient');

/**
 * Start a fake guard. `decide({ nth, onSocket })` gets the request's number
 * overall and on its socket (both 1-based) and returns 'answer' or 'kill'.
 */
async function fakeGuard(decide) {
    const seen = [];
    let sockets = 0;
    const server = http.createServer((req, res) => {
        if (req.socket.__n === undefined) { sockets += 1; req.socket.__n = 0; }
        req.socket.__n += 1;
        const entry = { nth: seen.length + 1, onSocket: req.socket.__n };
        seen.push(entry);
        req.resume();
        req.on('end', () => {
            if (decide(entry) === 'kill') { req.socket.destroy(); return; }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, nth: entry.nth }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/pii`;
    return {
        url,
        seen,
        sockets: () => sockets,
        async close() {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

// Let the agent return the first request's socket to its free pool.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a keep-alive socket closed between two requests: the second succeeds via one retry', async () => {
    // Kill the second request on any socket: exactly the stale keep-alive race.
    const guard = await fakeGuard(({ onSocket }) => (onSocket > 1 ? 'kill' : 'answer'));
    try {
        const first = await httpPost(guard.url, { text: 'a' });
        assert.strictEqual(first.ok, true);
        await settle();
        const second = await httpPost(guard.url, { text: 'b' });
        assert.strictEqual(second.ok, true, 'the retry on a fresh socket should have answered');
        assert.strictEqual(guard.seen.length, 3, 'expected the first request, the killed reuse, and one retry');
        assert.strictEqual(guard.sockets(), 2, 'the retry must go out on a new socket');
    } finally {
        await guard.close();
    }
});

test('a reset on a FRESH socket is not retried', async () => {
    const guard = await fakeGuard(() => 'kill');
    try {
        await assert.rejects(httpPost(guard.url, { text: 'a' }), (err) => err.code === 'ECONNRESET' || err.code === 'EPIPE');
        assert.strictEqual(guard.seen.length, 1, 'a broken guard must not get a second request');
    } finally {
        await guard.close();
    }
});

test('the retry happens at most once: a second reset still fails', async () => {
    // Answer only the very first request; kill everything after it.
    const guard = await fakeGuard(({ nth }) => (nth === 1 ? 'answer' : 'kill'));
    try {
        await httpPost(guard.url, { text: 'a' });
        await settle();
        await assert.rejects(httpPost(guard.url, { text: 'b' }));
        assert.strictEqual(guard.seen.length, 3, 'expected exactly one retry after the stale-socket reset');
    } finally {
        await guard.close();
    }
});
