'use strict';

/**
 * A closed tab stops a builder stream (routes/ai/automationBuilder/clientGone.js).
 *
 * Over a real socket, with a JSON body parsed before the handler runs, exactly
 * like POST /api/automation/builder/stream: the handler awaits its setup, then
 * registers for "the client is gone". The client then closes the stream.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/clientGone.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { onClientGone } = require('./clientGone');

/**
 * One streaming POST. `clientAction` decides what the client does once the
 * first event arrived; resolves with how often onGone ran.
 * @param {{ endByServer: boolean }} opts
 */
function streamOnce({ endByServer }) {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.json());
        let gone = 0;
        app.post('/stream', async (req, res) => {
            // The awaits a real handler does before it opens its loop.
            await new Promise((r) => setTimeout(r, 30));
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('event: hello\ndata: {}\n\n');
            onClientGone(req, res, () => { gone += 1; });
            if (endByServer) setTimeout(() => res.end(), 30);
        });
        const server = app.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('net').AddressInfo} */ (server.address());
            const client = http.request({ host: '127.0.0.1', port, path: '/stream', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
                res.once('data', () => {
                    if (!endByServer) setTimeout(() => client.destroy(), 30);
                    // Long enough for the server to notice either ending.
                    setTimeout(() => server.close(() => resolve(gone)), 250);
                });
                res.on('error', () => {});
            });
            client.on('error', () => {});
            client.end(JSON.stringify({ message: 'build me something' }));
        });
        server.on('error', reject);
    });
}

test('a client that closes the stream of a POST with a body is noticed, once', async () => {
    assert.strictEqual(await streamOnce({ endByServer: false }), 1);
});

test('our own end of the stream is not read as the client leaving', async () => {
    assert.strictEqual(await streamOnce({ endByServer: true }), 0);
});
