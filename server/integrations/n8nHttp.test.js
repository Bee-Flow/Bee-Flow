const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const MODULE = require.resolve('./n8nHttp');

/** A fresh copy of the module under a given value of the opt-in. */
function loadWith(flag) {
    const before = process.env.N8N_ALLOW_INSECURE_TLS;
    if (flag === undefined) delete process.env.N8N_ALLOW_INSECURE_TLS;
    else process.env.N8N_ALLOW_INSECURE_TLS = flag;
    delete require.cache[MODULE];
    try {
        return require(MODULE);
    } finally {
        delete require.cache[MODULE];
        if (before === undefined) delete process.env.N8N_ALLOW_INSECURE_TLS;
        else process.env.N8N_ALLOW_INSECURE_TLS = before;
    }
}

const { n8nFetch, multipartBody } = loadWith(undefined);

test('the opt-in is exactly the string 1, read once at load', () => {
    assert.equal(loadWith(undefined).allowInsecureTls(), false);
    assert.equal(loadWith('1').allowInsecureTls(), true);
    for (const looser of ['0', 'false', 'yes', 'true', '']) {
        assert.equal(loadWith(looser).allowInsecureTls(), false, `value ${JSON.stringify(looser)}`);
    }
    const loaded = loadWith(undefined);
    process.env.N8N_ALLOW_INSECURE_TLS = '1';
    try {
        assert.equal(loaded.allowInsecureTls(), false, 'a later env change must not flip a loaded module');
    } finally {
        delete process.env.N8N_ALLOW_INSECURE_TLS;
    }
});

test('without the opt-in every call, https included, is the platform fetch', async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{}'); };
    try {
        await n8nFetch('https://n8n.example/api/v1/workflows', { headers: { a: '1' } });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://n8n.example/api/v1/workflows');
        assert.equal('dispatcher' in calls[0].init, false);
    } finally {
        globalThis.fetch = original;
    }
});

test('with the opt-in only https calls leave the platform fetch', async () => {
    const opted = loadWith('1');
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{}'); };
    try {
        await opted.n8nFetch('http://n8n.internal/api/v1/workflows');
        assert.deepEqual(calls, ['http://n8n.internal/api/v1/workflows'], 'plain http still goes through fetch');
        // https with verification off goes through undici; nothing listens on
        // this port, so the call fails at connect, and the point is that the
        // platform fetch was never asked.
        await assert.rejects(opted.n8nFetch('https://127.0.0.1:1/', { signal: AbortSignal.timeout(2000) }));
        assert.equal(calls.length, 1);
    } finally {
        globalThis.fetch = original;
    }
});

test('plain http goes through the global fetch, with the init passed along', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, key: req.headers['x-n8n-api-key'], body });
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const url = `http://127.0.0.1:${server.address().port}/hook`;
        const res = await n8nFetch(url, { method: 'POST', headers: { 'X-N8N-API-KEY': 'k' }, body: '{"a":1}' });
        assert.deepEqual(await res.json(), { ok: true });
        assert.deepEqual(seen, [{ method: 'POST', key: 'k', body: '{"a":1}' }]);
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('multipartBody carries fields as strings and files as named blobs', async () => {
    const form = multipartBody(
        { text: 'hello', meta: { a: 1 } },
        [{ fieldName: 'upload', name: 'a.txt', mimeType: 'text/plain', content: Buffer.from('abc') },
         { name: 'b.bin', content: Buffer.from('xyz').toString('base64') }],
    );
    assert.equal(form.get('text'), 'hello');
    assert.equal(form.get('meta'), '{"a":1}');
    const a = form.get('upload');
    assert.equal(a.name, 'a.txt');
    assert.equal(a.type, 'text/plain');
    assert.equal(await a.text(), 'abc');
    const b = form.get('file');
    assert.equal(b.name, 'b.bin');
    assert.equal(b.type, 'application/octet-stream');
    assert.equal(await b.text(), 'xyz');
});
