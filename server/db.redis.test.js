/**
 * Unit — db.js Redis client behaviour during an outage, with a real ioredis
 * client against a stand-in Redis server on a local socket (DB-free).
 *
 * The client reconnects forever (a client that gave up stayed dead until a
 * restart). That must not turn an outage into a hang: a command sent while
 * disconnected fails at once, so requireAuth and the session tokens fall
 * back to Postgres instead of waiting for reconnect attempts that back off
 * to 30 s. Before the first connection commands still wait for it, and a
 * duplicated subscriber keeps its queue.
 *
 * Run: cd server && node --test db.redis.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const Redis = require('ioredis');
const { _redisOptions, _failFastWhenDisconnected } = require('./db');

/** A Redis that answers every command with a nil, until it is stopped. */
async function standInRedis(port = 0) {
    const sockets = new Set();
    const server = net.createServer((sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => {});
        sock.on('data', (buf) => {
            const commands = buf.toString('latin1').split('\r\n').filter((l) => /^\*\d+$/.test(l)).length;
            sock.write('$-1\r\n'.repeat(commands));
        });
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    return {
        port: server.address().port,
        stop: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
    };
}

test('the retry strategy never gives up and backs off to 30 s', () => {
    const { retryStrategy } = _redisOptions('redis://x');
    assert.strictEqual(retryStrategy(1), 200);
    assert.strictEqual(retryStrategy(1000), 30_000);
});

test('while Redis is down a command fails at once; before the first connection it waits', async () => {
    const redis = await standInRedis();
    const url = `redis://127.0.0.1:${redis.port}`;
    const client = _failFastWhenDisconnected(new Redis(url, { ..._redisOptions(url), enableReadyCheck: false }));
    client.on('error', () => {});
    try {
        // Boot: sent before the connection is up, answered once it is.
        assert.strictEqual(await client.get('k'), null);
        assert.strictEqual(client.status, 'ready');

        await redis.stop();
        const start = Date.now();
        while (client.status === 'ready' && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 5));
        assert.notStrictEqual(client.status, 'ready');

        const t0 = Date.now();
        await assert.rejects(client.get('k'));
        assert.ok(Date.now() - t0 < 150, `failed fast (${Date.now() - t0} ms), not after the reconnect back-off`);

        const sub = client.duplicate();
        assert.strictEqual(sub.options.enableOfflineQueue, true, 'a subscriber still queues its SUBSCRIBE');
        sub.disconnect();
    } finally {
        client.disconnect();
    }
});
