const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createRemoteDigest, registryTransportOptions } = require('./registryDigest');

const DIGEST = 'sha256:' + 'a'.repeat(64);
const CREDS = { registryUrl: 'registry.example.test', user: 'robot', token: 'not-a-real-token' };
const BASIC = `Basic ${Buffer.from('robot:not-a-real-token').toString('base64')}`;

/**
 * A stand-in for http(s).request. `outcomes` maps a protocol to what its
 * request does: { status, digest } answers, { error } fails, { timeout } hangs.
 * Every request's protocol, options and request object are recorded in `calls`.
 */
function fakeTransport(outcomes) {
    const calls = [];
    const request = (protocol, options, onResponse) => {
        const req = new EventEmitter();
        calls.push({ protocol, options, req });
        req.destroy = () => { req.destroyed = true; };
        req.end = () => setImmediate(() => {
            const o = outcomes[protocol];
            if (!o) throw new Error(`unexpected ${protocol} request`);
            if (o.error) return req.emit('error', new Error(o.error));
            if (o.timeout) return req.emit('timeout');
            const resp = new EventEmitter();
            resp.statusCode = o.status;
            resp.headers = o.digest ? { 'docker-content-digest': o.digest } : {};
            onResponse(resp);
            resp.emit('end');
        });
        return req;
    };
    return { calls, request };
}

test('by default the manifest is read over verified HTTPS, with the credentials', async () => {
    const t = fakeTransport({ https: { status: 200, digest: DIGEST } });
    const getRemoteDigest = createRemoteDigest({ ...CREDS, request: t.request });
    const r = await getRemoteDigest('beeflow/server');
    assert.deepEqual(r, { digest: DIGEST, status: 200, error: null });
    assert.equal(t.calls.length, 1);
    const [{ protocol, options }] = t.calls;
    assert.equal(protocol, 'https');
    assert.equal(options.hostname, 'registry.example.test');
    assert.equal(options.port, 443);
    assert.equal(options.path, '/v2/beeflow/server/manifests/latest');
    assert.equal(options.headers.Authorization, BASIC);
    assert.notEqual(options.rejectUnauthorized, false, 'TLS verification stays on');
});

test('by default a failed HTTPS attempt is the answer: nothing is retried over HTTP', async () => {
    for (const outcome of [{ status: 401 }, { status: 503 }, { error: 'self-signed certificate' }, { timeout: true }]) {
        const t = fakeTransport({ https: outcome });
        const r = await createRemoteDigest({ ...CREDS, request: t.request })('beeflow/server');
        assert.equal(r.digest, null);
        assert.ok(r.error, `an error is reported for ${JSON.stringify(outcome)}`);
        assert.deepEqual(t.calls.map((c) => c.protocol), ['https']);
    }
});

test('REGISTRY_ALLOW_HTTP retries over HTTP, and that request never carries the credentials', async () => {
    const t = fakeTransport({ https: { error: 'connect ECONNREFUSED' }, http: { status: 200, digest: DIGEST } });
    const r = await createRemoteDigest({ ...CREDS, allowHttp: true, request: t.request })('beeflow/server');
    assert.equal(r.digest, DIGEST);
    assert.deepEqual(t.calls.map((c) => c.protocol), ['https', 'http']);
    const httpCall = t.calls[1];
    assert.equal(httpCall.options.port, 80);
    assert.equal(httpCall.options.headers.Authorization, undefined);
    assert.ok(!Object.keys(httpCall.options.headers).some((h) => h.toLowerCase() === 'authorization'));
});

test('REGISTRY_ALLOW_HTTP does not retry when HTTPS already answered with a digest', async () => {
    const t = fakeTransport({ https: { status: 200, digest: DIGEST } });
    await createRemoteDigest({ ...CREDS, allowHttp: true, request: t.request })('beeflow/server');
    assert.deepEqual(t.calls.map((c) => c.protocol), ['https']);
});

test('REGISTRY_INSECURE_TLS turns certificate verification off for the HTTPS request only', async () => {
    const t = fakeTransport({ https: { status: 200, digest: DIGEST } });
    await createRemoteDigest({ ...CREDS, insecureTls: true, request: t.request })('beeflow/server');
    assert.equal(t.calls[0].options.rejectUnauthorized, false);
});

test('a protocol prefix and an explicit port in REGISTRY_URL are honoured', async () => {
    const t = fakeTransport({ https: { status: 404 }, http: { status: 404 } });
    await createRemoteDigest({ ...CREDS, registryUrl: 'https://registry.example.test:5000/', allowHttp: true, request: t.request })('beeflow/agent-hub');
    assert.deepEqual(t.calls.map((c) => [c.protocol, c.options.hostname, c.options.port]), [
        ['https', 'registry.example.test', 5000],
        ['http', 'registry.example.test', 5000],
    ]);
});

test('a timeout destroys the request and reports it', async () => {
    const t = fakeTransport({ https: { timeout: true } });
    const r = await createRemoteDigest({ ...CREDS, request: t.request })('beeflow/server');
    assert.deepEqual(r, { digest: null, status: 0, error: 'timeout' });
    assert.equal(t.calls[0].req.destroyed, true);
});

test('the opt-ins are read from the environment and only the value 1 enables one', () => {
    assert.deepEqual(registryTransportOptions({}), { insecureTls: false, allowHttp: false });
    assert.deepEqual(registryTransportOptions({ REGISTRY_INSECURE_TLS: '1', REGISTRY_ALLOW_HTTP: '1' }), { insecureTls: true, allowHttp: true });
    assert.deepEqual(registryTransportOptions({ REGISTRY_INSECURE_TLS: 'true', REGISTRY_ALLOW_HTTP: 'yes' }), { insecureTls: false, allowHttp: false });
});
