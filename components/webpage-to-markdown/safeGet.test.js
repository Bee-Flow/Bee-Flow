'use strict';
// node --test components/webpage-to-markdown/safeGet.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { safeGet, PRIVATE_ADDRESS_ERROR_CODE } = require('./safeGet');
const { fetchAndConvert } = require('./index');

let server;
let port;
let hits = 0;

before(async () => {
    server = http.createServer((req, res) => {
        hits++;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>internal</title></head><body><p>secret admin page</p></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(() => new Promise(resolve => server.close(resolve)));

const DIRECT = {}; // no proxy variables
const refused = err => err.code === PRIVATE_ADDRESS_ERROR_CODE;

/** An axios.request stand-in that answers from a list and records the URLs asked. */
function scripted(responses) {
    const calls = [];
    const request = async config => {
        calls.push(config);
        const next = responses.shift();
        if (!next) throw new Error('unexpected request');
        return { status: next.status, headers: next.headers || {}, data: next.data || '', config };
    };
    return { request, calls };
}

test('fetchAndConvert refuses a loopback URL instead of returning the internal page', async () => {
    const before = hits;
    await assert.rejects(fetchAndConvert(`http://127.0.0.1:${port}/`), refused);
    assert.equal(hits, before, 'the internal server was never contacted');
});

test('the metadata address and its numeric spellings are refused before any request', async () => {
    for (const url of [
        'http://169.254.169.254/latest/meta-data/',
        'http://2852039166/latest/meta-data/',
        'http://[::ffff:169.254.169.254]/',
        'http://localhost:3101/api/health',
        'http://metadata.google.internal/',
    ]) {
        const { request, calls } = scripted([]);
        await assert.rejects(safeGet(url, {}, { request, env: DIRECT }), refused, url);
        assert.equal(calls.length, 0, url);
    }
});

test('a name that resolves to a private address is refused at connect', async () => {
    const before = hits;
    const lookup = (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    await assert.rejects(
        safeGet(`http://internal.example:${port}/`, {}, { lookup, env: DIRECT }),
        refused,
    );
    assert.equal(hits, before);
});

test('a redirect to the metadata endpoint is refused before the second request', async () => {
    const { request, calls } = scripted([
        { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/iam/' } },
    ]);
    await assert.rejects(safeGet('https://public.example/page', {}, { request, env: DIRECT }), refused);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxRedirects, 0, 'axios never follows a redirect itself');
});

test('a relative redirect to a loopback host and port is refused too', async () => {
    const { request, calls } = scripted([
        { status: 301, headers: { location: `//127.0.0.1:${port}/admin` } },
    ]);
    await assert.rejects(safeGet('http://public.example/', {}, { request, env: DIRECT }), refused);
    assert.equal(calls.length, 1);
});

test('public redirects are followed and the final URL is reported', async () => {
    const { request, calls } = scripted([
        { status: 301, headers: { location: '/moved' } },
        { status: 302, headers: { location: 'https://www.public.example/final' } },
        { status: 200, data: '<p>ok</p>' },
    ]);
    const { response, url } = await safeGet('http://public.example/start', { responseType: 'text' }, { request, env: DIRECT });
    assert.equal(response.data, '<p>ok</p>');
    assert.equal(url, 'https://www.public.example/final');
    assert.deepEqual(calls.map(c => c.url), [
        'http://public.example/start',
        'http://public.example/moved',
        'https://www.public.example/final',
    ]);
    for (const c of calls) {
        assert.equal(c.proxy, false);
        assert.ok(c.httpAgent && c.httpsAgent, 'direct connections go through the guarded agents');
        assert.equal(c.responseType, 'text');
    }
});

test('more redirects than allowed fail like follow-redirects did', async () => {
    const loop = Array.from({ length: 7 }, (_, i) => ({ status: 302, headers: { location: `/r${i}` } }));
    const { request, calls } = scripted(loop);
    await assert.rejects(
        safeGet('https://public.example/', { maxRedirects: 5 }, { request, env: DIRECT }),
        /Maximum number of redirects exceeded/,
    );
    assert.equal(calls.length, 6);
});

test('a status outside validateStatus fails with the axios message', async () => {
    const { request } = scripted([{ status: 404 }]);
    await assert.rejects(
        safeGet('https://public.example/missing', {}, { request, env: DIRECT }),
        /Request failed with status code 404/,
    );
    const sitemapStyle = scripted([{ status: 304 }]);
    const { response } = await safeGet('https://public.example/s.xml', {
        validateStatus: s => s >= 200 && s < 400,
    }, { request: sitemapStyle.request, env: DIRECT });
    assert.equal(response.status, 304);
});

test('only http and https are fetched', async () => {
    const { request, calls } = scripted([]);
    await assert.rejects(safeGet('file:///etc/passwd', {}, { request, env: DIRECT }), /Unsupported protocol file:/);
    assert.equal(calls.length, 0);
});

test('behind a proxy each hop name is resolved first and refused when private', async () => {
    const env = { HTTPS_PROXY: 'http://proxy.corp:3128' };
    const lookup = (host, opts, cb) => {
        if (host === 'rebind.example') return cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
        if (host === 'unknown.example') return cb(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
        return cb(null, [{ address: '93.184.216.34', family: 4 }]);
    };

    const blocked = scripted([]);
    await assert.rejects(safeGet('https://rebind.example/', {}, { request: blocked.request, lookup, env }), refused);
    assert.equal(blocked.calls.length, 0);

    // A name only the proxy can resolve is still fetched through the proxy,
    // and the proxy keeps doing the connecting (no guarded agent, no proxy: false).
    const ok = scripted([{ status: 200, data: 'ok' }]);
    await safeGet('https://unknown.example/', {}, { request: ok.request, lookup, env });
    assert.equal(ok.calls.length, 1);
    assert.equal(ok.calls[0].proxy, undefined);
    assert.equal(ok.calls[0].httpsAgent, undefined);

    const redirect = scripted([{ status: 302, headers: { location: 'https://rebind.example/' } }]);
    await assert.rejects(safeGet('https://public.example/', {}, { request: redirect.request, lookup, env }), refused);
    assert.equal(redirect.calls.length, 1);
});
