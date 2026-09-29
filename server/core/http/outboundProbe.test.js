/**
 * outboundProbe's contract with its callers, now that it captures off the
 * connection instead of routing fetch through a probe Agent.
 *
 * The old global fetch shim handed every call inside a probe to the npm
 * `undici` fetch, which did not recognise Node's own Request class: an SDK
 * that builds a Request first (Mistral's does) failed with "Failed to parse
 * URL from [object Request]". The shim is gone, so a Request goes to Node's
 * own fetch untouched; these tests hold that, and that the probe still
 * records where the socket went.
 *
 * Run: cd server && node --test core/http/outboundProbe.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const nativeFetch = globalThis.fetch;
const probeApi = require('./outboundProbe');
const { runWithProbe, currentProbe, markLocal } = probeApi;

let server;
let baseUrl;

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
                method: req.method,
                body,
                contentType: req.headers['content-type'] || null,
                contentLength: req.headers['content-length'] || null,
                custom: req.headers['x-custom'] || null,
            }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

test('requiring the probe leaves globalThis.fetch alone', () => {
    assert.strictEqual(globalThis.fetch, nativeFetch);
    for (const gone of ['probedFetch', 'probeAgent', 'dnsPreCallProbe', 'installGlobalFetchShim']) {
        assert.ok(!(gone in probeApi), `${gone} is removed`);
    }
});

test('a native Request POST inside runWithProbe keeps method, headers and body, and records a peer', async () => {
    const request = new Request(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
        body: JSON.stringify({ model: 'm' }),
    });
    const { result, probe } = await runWithProbe(async () => (await fetch(request)).json());
    assert.deepStrictEqual(result, {
        method: 'POST',
        body: '{"model":"m"}',
        contentType: 'application/json',
        contentLength: '13',
        custom: 'yes',
    });
    assert.strictEqual(probe.peers.length, 1);
    assert.strictEqual(probe.peers[0].ip, '127.0.0.1');
    assert.strictEqual(probe.peers[0].method, 'POST');
    assert.strictEqual(probe.peer_ip_source, 'socket');
});

test('an explicit init still overrides the Request, as it does for fetch itself', async () => {
    const request = new Request(`${baseUrl}/x`, { method: 'POST', body: 'from-request' });
    const { result } = await runWithProbe(async () => (await fetch(request, { method: 'PUT', body: 'from-init' })).json());
    assert.strictEqual(result.method, 'PUT');
    assert.strictEqual(result.body, 'from-init');
});

test('the Request signal still aborts the call', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller went away'));
    const request = new Request(`${baseUrl}/z`, { signal: controller.signal });
    await assert.rejects(runWithProbe(() => fetch(request)));
});

test('currentProbe is live inside the call and gone after it', async () => {
    assert.strictEqual(currentProbe(), null);
    let inside = null;
    const { probe } = await runWithProbe(async () => { inside = currentProbe(); markLocal('Local Whisper'); });
    assert.ok(inside, 'a probe is active inside runWithProbe');
    assert.strictEqual(currentProbe(), null);
    assert.strictEqual(probe.is_local, true);
    assert.strictEqual(probe.local_label, 'Local Whisper');
    assert.deepStrictEqual(probe.peers, []);
});

test('outsideProbe: a call made through it belongs to no probe', async () => {
    const { probe } = await runWithProbe(() => probeApi.outsideProbe(async () => (await fetch(`${baseUrl}/m`)).json()));
    assert.deepStrictEqual(probe.peers, []);
});
