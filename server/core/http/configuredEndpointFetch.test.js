'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { fetchConfiguredEndpoint, isMetadataOrLinkLocal } = require('./configuredEndpointFetch');

test('metadata and link-local addresses are recognised in every spelling', () => {
    for (const a of ['169.254.169.254', '2852039166', '0xa9fea9fe', '::ffff:169.254.169.254', 'fe80::1', 'fd00:ec2::254', '0.0.0.0', '::']) {
        assert.equal(isMetadataOrLinkLocal(a), true, a);
    }
    for (const a of ['127.0.0.1', '10.0.0.5', '192.168.1.2', '8.8.8.8', 'ollama']) {
        assert.equal(isMetadataOrLinkLocal(a), false, a);
    }
});

test('refuses the cloud metadata service and non-http schemes', async () => {
    await assert.rejects(fetchConfiguredEndpoint('http://169.254.169.254/latest/meta-data/'), /Refused/);
    await assert.rejects(fetchConfiguredEndpoint('http://metadata.google.internal/'), /Refused/);
    await assert.rejects(fetchConfiguredEndpoint('file:///etc/passwd'), /http\(s\)/);
});

test('still reaches a private-network runtime (loopback) and does not follow redirects', async () => {
    const srv = http.createServer((req, res) => {
        if (req.url === '/r') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); return res.end(); }
        res.end('ok');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = /** @type {any} */ (srv.address());
    try {
        const res = await fetchConfiguredEndpoint(`http://127.0.0.1:${port}/v1/models`);
        assert.equal(await res.text(), 'ok');
        await assert.rejects(fetchConfiguredEndpoint(`http://127.0.0.1:${port}/r`));
    } finally { srv.close(); }
});
