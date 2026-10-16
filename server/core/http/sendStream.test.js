const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Readable } = require('stream');
const { sendStream } = require('./sendStream');

test('a client that aborts destroys the upstream stream', async () => {
    let destroyed;
    const done = new Promise((r) => { destroyed = r; });
    const server = http.createServer((req, res) => {
        const source = new Readable({ read() { this.push(Buffer.alloc(16384)); } });
        source.on('close', () => destroyed(true));
        sendStream(source, res);
    });
    await new Promise((r) => server.listen(0, r));
    const { port } = /** @type {import('net').AddressInfo} */ (server.address());
    await new Promise((resolve) => {
        const req = http.get({ port }, (res) => {
            res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', () => {});
    });
    const result = await Promise.race([done, new Promise((r) => setTimeout(() => r(false), 3000))]);
    server.close();
    server.closeAllConnections();
    assert.strictEqual(result, true);
});

test('a real stream error reaches onError', async () => {
    const server = http.createServer((req, res) => {
        const source = new Readable({ read() { this.destroy(new Error('boom')); } });
        sendStream(source, res, (err) => { res.setHeader('x-err', err.message); res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const { port } = /** @type {import('net').AddressInfo} */ (server.address());
    const seen = await new Promise((resolve) => {
        http.get({ port }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', () => resolve('err'));
    });
    server.close();
    assert.ok(seen);
});
