const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3RequestHandlerOptions, s3ClientConfig } = require('./storageClientConfig');

test('defaults: connection 5 s, socket idle 60 s, pool of 100, no warn-only requestTimeout', async () => {
    const opts = s3RequestHandlerOptions();
    assert.strictEqual(opts.connectionTimeout, 5000);
    assert.strictEqual(opts.socketTimeout, 60000);
    assert.strictEqual(opts.httpsAgent.maxSockets, 100);
    assert.strictEqual('requestTimeout' in opts, false);
    const client = new S3Client(s3ClientConfig('http://127.0.0.1:1', 'a', 'b'));
    const cfg = await client.config.requestHandler.configProvider;
    assert.strictEqual(cfg.socketTimeout, 60000);
    assert.strictEqual((await cfg.httpAgentProvider()).maxSockets, 100);
    client.destroy();
});

async function withStalledServer(onRequest, fn) {
    const sockets = new Set();
    const server = http.createServer(onRequest);
    server.on('connection', (s) => sockets.add(s));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const prev = process.env.STORAGE_SOCKET_TIMEOUT_MS;
    process.env.STORAGE_SOCKET_TIMEOUT_MS = '200';
    const client = new S3Client(s3ClientConfig(`http://127.0.0.1:${server.address().port}`, 'a', 'b'));
    try {
        await fn(client);
    } finally {
        if (prev === undefined) delete process.env.STORAGE_SOCKET_TIMEOUT_MS; else process.env.STORAGE_SOCKET_TIMEOUT_MS = prev;
        client.destroy();
        sockets.forEach((s) => s.destroy());
        server.close();
    }
}

test('a server that never answers ends in a timeout error', async () => {
    await withStalledServer(() => { /* never respond */ }, async (client) => {
        await assert.rejects(
            client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' })),
            (e) => e.name === 'TimeoutError' || /timeout/i.test(e.message),
        );
    });
});

test('a body that stalls mid-download errors instead of holding the socket', async () => {
    await withStalledServer((req, res) => {
        res.writeHead(200, { 'content-length': '100000' });
        res.write(Buffer.alloc(10)); // then stall
    }, async (client) => {
        const out = await client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
        await assert.rejects(async () => { for await (const _ of out.Body) { /* drain */ } });
    });
});
