// @typecheck
/**
 * Unit tests for connector/ncVerify.js: the stable instance-id fallback and the
 * capabilities round-trip's SSRF gate.
 *
 * Run: cd server && node --test auth/connector/ncVerify.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./ncVerify');

test('stableInstanceIdFallback: host-keyed and version-independent', () => {
    assert.equal(helpers.stableInstanceIdFallback('https://nc.example.com/', 'Acme'), 'nc-host:nc.example.com');
    // host includes the port; path is ignored
    assert.equal(helpers.stableInstanceIdFallback('https://nc.example.com:8443/foo', 'Acme'), 'nc-host:nc.example.com:8443');
});

test('stableInstanceIdFallback: malformed URL falls back to theming name', () => {
    assert.equal(helpers.stableInstanceIdFallback('not a url', 'Acme'), 'nc:Acme');
    assert.equal(helpers.stableInstanceIdFallback('', null), 'nc:nextcloud');
});

// verifyNcInstance — the base URL comes from an unauthenticated header, so it
// must not turn the server into a probe of its own network (SSRF).
const http = require('node:http');

/** A fake "internal" Nextcloud on loopback that counts the requests it gets. */
async function withLoopbackNc(fn) {
    let hits = 0;
    const srv = http.createServer((req, res) => {
        hits++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ocs: { data: { version: { string: '30.0.0' }, capabilities: { theming: { instanceid: 'internal-id', name: 'Internal' } } } } }));
    });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
    try {
        await fn(`http://127.0.0.1:${port}`, () => hits);
    } finally {
        await new Promise(resolve => srv.close(() => resolve(undefined)));
    }
}

function withPrivateHostsFlag(value, fn) {
    const prev = process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    if (value === undefined) delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    else process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = value;
    return Promise.resolve(fn()).finally(() => {
        if (prev === undefined) delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
        else process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = prev;
    });
}

test('verifyNcInstance: refuses a loopback base URL without sending a request', async () => {
    await withPrivateHostsFlag(undefined, () => withLoopbackNc(async (base, hits) => {
        await assert.rejects(helpers.verifyNcInstance(base, 'internal-id'), /NC capabilities unreachable/);
        assert.equal(hits(), 0, 'the internal host must never be contacted');
    }));
});

test('verifyNcInstance: refuses cloud metadata and private hosts (classified as unreachable)', async () => {
    await withPrivateHostsFlag(undefined, async () => {
        for (const base of ['http://169.254.169.254/latest', 'http://10.0.0.5', 'http://localhost:3101', 'http://[::1]:80', 'http://user:pw@nc.example.com']) {
            await assert.rejects(helpers.verifyNcInstance(base, 'x'), /NC capabilities unreachable/, base);
        }
    });
});

test('verifyNcInstance: metadata stays refused even with NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1', async () => {
    await withPrivateHostsFlag('1', async () => {
        await assert.rejects(helpers.verifyNcInstance('http://169.254.169.254', 'x'), /NC capabilities unreachable/);
    });
});

test('verifyNcInstance: NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 keeps a LAN self-host working', async () => {
    await withPrivateHostsFlag('1', () => withLoopbackNc(async (base, hits) => {
        const nc = await helpers.verifyNcInstance(base, 'internal-id');
        assert.deepEqual(nc, { themingName: 'Internal', ncVersion: '30.0.0' });
        assert.equal(hits(), 1);
    }));
});

test('verifyNcInstance: a host list allows exactly the listed private hosts', async () => {
    await withPrivateHostsFlag('nextcloud.lan, 127.0.0.1:8080', () => withLoopbackNc(async (base, hits) => {
        const nc = await helpers.verifyNcInstance(base, 'internal-id');
        assert.equal(nc.ncVersion, '30.0.0');
        assert.equal(hits(), 1);
        await assert.rejects(helpers.verifyNcInstance('http://10.0.0.5', 'x'), /NC capabilities unreachable/);
        await assert.rejects(helpers.verifyNcInstance('http://169.254.169.254', 'x'), /NC capabilities unreachable/);
    }));
    await withPrivateHostsFlag('nextcloud.lan', () => withLoopbackNc(async (base, hits) => {
        await assert.rejects(helpers.verifyNcInstance(base, 'internal-id'), /NC capabilities unreachable/);
        assert.equal(hits(), 0, 'an unlisted private host is never contacted');
    }));
});

test('verifyNcInstance: the base URL cannot carry a query or fragment; the suffix stays the path', async () => {
    await withPrivateHostsFlag('1', () => withLoopbackNc(async (base, hits) => {
        for (const bad of [`${base}/x?`, `${base}/x#`, `${base}?a=1`]) {
            await assert.rejects(helpers.verifyNcInstance(bad, 'internal-id'), (e) => helpers.verifyFailureCategory(e) === 'unreachable', bad);
        }
        assert.equal(hits(), 0);
    }));
});

test('verifyNcInstance: every failure has a category; the text stays on the server', async () => {
    const http2 = require('node:http');
    const answers = [
        (res) => { res.statusCode = 500; res.end('internal secret page'); },
        (res) => { res.setHeader('content-type', 'text/html'); res.end('<html>admin panel</html>'); },
        (res) => { res.end(JSON.stringify({ ocs: { data: { version: { string: '1' }, capabilities: { theming: { instanceid: 'other' } } } } })); },
    ];
    for (const answer of answers) {
        const srv = http2.createServer((_req, res) => answer(res));
        await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
        const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
        try {
            await withPrivateHostsFlag('1', async () => {
                await assert.rejects(helpers.verifyNcInstance(`http://127.0.0.1:${port}`, 'mine'), (e) => helpers.verifyFailureCategory(e) === 'mismatch');
            });
        } finally { await new Promise((r) => srv.close(() => r(undefined))); }
    }
    assert.equal(helpers.verifyFailureCategory(new Error('anything')), 'unreachable');
});
