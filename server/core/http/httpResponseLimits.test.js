const { test } = require('node:test');
const assert = require('node:assert');
const { HTTP_RESPONSE_CAP, MAX_BYTES_PER_CHAR, readBodyBounded, readBytesBounded, envByteLimit } = require('./httpResponseLimits');

// A streamed Response whose chunks we can count, to prove the read stops early.
function streamed(chunkCount, chunkSize, headers = {}) {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream({
        pull(controller) {
            if (pulled >= chunkCount) return controller.close();
            pulled++;
            controller.enqueue(new Uint8Array(chunkSize).fill(97)); // 'a'
        },
        cancel() { cancelled = true; },
    });
    const resp = new Response(body, { headers });
    return { resp, pulled: () => pulled, cancelled: () => cancelled };
}

test('small body is returned whole, not truncated', async () => {
    const r = await readBodyBounded(new Response('hello'));
    assert.deepEqual(r, { text: 'hello', truncated: false });
});

test('body of exactly the cap is not truncated; one more char is', async () => {
    assert.equal((await readBodyBounded(new Response('a'.repeat(100)), { charCap: 100 })).truncated, false);
    const over = await readBodyBounded(new Response('a'.repeat(101)), { charCap: 100 });
    assert.equal(over.truncated, true);
    assert.equal(over.text.length, 100);
});

test('BFSF-460: an unbounded stream is cancelled at the byte budget, not buffered', async () => {
    const cap = 1000;
    const s = streamed(1_000_000, 1024); // would be ~1 GB
    const r = await readBodyBounded(s.resp, { charCap: cap });
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, cap);
    assert.ok(s.cancelled(), 'stream cancelled');
    assert.ok(s.pulled() * 1024 <= cap * MAX_BYTES_PER_CHAR + 64 * 1024, `pulled ${s.pulled()} chunks`);
});

test('Content-Length over the budget skips the body when asked to', async () => {
    const s = streamed(10, 10, { 'content-length': String(HTTP_RESPONSE_CAP * MAX_BYTES_PER_CHAR + 1) });
    const r = await readBodyBounded(s.resp, { stopOnOversizeHeader: true });
    assert.deepEqual(r, { text: '', truncated: true });
    assert.equal(s.pulled(), 0);
});

test('multi-byte text is measured in characters, not bytes', async () => {
    const r = await readBodyBounded(new Response('é'.repeat(100)), { charCap: 100 });
    assert.equal(r.truncated, false);
    assert.equal(r.text.length, 100);
});

test('a response without a stream falls back to text()', async () => {
    const r = await readBodyBounded({ headers: new Headers(), text: async () => 'x'.repeat(10) }, { charCap: 5 });
    assert.deepEqual(r, { text: 'xxxxx', truncated: true });
});

test('a bodyless response (HEAD / 204) with a huge Content-Length is not oversize', async () => {
    const headers = { 'content-length': String(HTTP_RESPONSE_CAP * MAX_BYTES_PER_CHAR + 1) };
    const r = await readBodyBounded(new Response(null, { headers }), { stopOnOversizeHeader: true });
    assert.deepEqual(r, { text: '', truncated: false });
    const r204 = await readBodyBounded(new Response(null, { status: 204, headers }), { stopOnOversizeHeader: true });
    assert.deepEqual(r204, { text: '', truncated: false });
});

test('a leading UTF-8 BOM is stripped, like Response#text()', async () => {
    const r = await readBodyBounded(new Response(new Uint8Array([0xEF, 0xBB, 0xBF, 0x7B, 0x7D])));
    assert.deepEqual(r, { text: '{}', truncated: false });
    assert.deepEqual(JSON.parse(r.text), {});
});

test('readBytesBounded: Content-Length over the cap cancels without reading', async () => {
    const { resp, pulled, cancelled } = streamed(10, 100, { 'content-length': '1000' });
    const r = await readBytesBounded(resp, { byteCap: 500 });
    assert.deepEqual({ t: r.truncated, b: r.buffer, d: r.declaredBytes }, { t: true, b: null, d: 1000 });
    assert.equal(pulled(), 0);
    assert.equal(cancelled(), true);
});

test('readBytesBounded: a streamed body without a header is cut once past the cap', async () => {
    const { resp, pulled, cancelled } = streamed(1000, 100);
    const r = await readBytesBounded(resp, { byteCap: 450 });
    assert.equal(r.truncated, true);
    assert.equal(r.declaredBytes, null);
    assert.ok(pulled() < 20, `pulled ${pulled()}`);
    assert.equal(cancelled(), true);
});

test('readBytesBounded: exactly at the cap is returned whole', async () => {
    const r = await readBytesBounded(new Response(Buffer.alloc(100, 97)), { byteCap: 100 });
    assert.equal(r.truncated, false);
    assert.equal(r.buffer.length, 100);
    assert.equal((await readBytesBounded(new Response(Buffer.alloc(101, 97)), { byteCap: 100 })).truncated, true);
});

test('readBytesBounded: cap 0 or Infinity means no cap', async () => {
    for (const byteCap of [0, Infinity]) {
        const r = await readBytesBounded(new Response(Buffer.alloc(5000, 97), { headers: { 'content-length': '5000' } }), { byteCap });
        assert.equal(r.truncated, false);
        assert.equal(r.buffer.length, 5000);
    }
});

test('envByteLimit: unset -> default, 0 -> Infinity, junk -> default', () => {
    const k = 'TEST_LIMIT_XYZ';
    delete process.env[k];
    assert.equal(envByteLimit(k, 7), 7);
    process.env[k] = '0';
    assert.equal(envByteLimit(k, 7), Infinity);
    process.env[k] = 'abc';
    assert.equal(envByteLimit(k, 7), 7);
    process.env[k] = '123';
    assert.equal(envByteLimit(k, 7), 123);
    delete process.env[k];
});

test('readTextOrThrowOversize: throws naming the env var; 0/Infinity reads all', async () => {
    const { readTextOrThrowOversize } = require('./httpResponseLimits');
    const opts = { byteCap: 100, what: 'Page x', envName: 'KB_X' };
    await assert.rejects(() => readTextOrThrowOversize(new Response('a'.repeat(500)), opts), /KB_X/);
    await assert.rejects(() => readTextOrThrowOversize(new Response('hi', { headers: { 'content-length': '5000' } }), opts), /KB_X/);
    assert.equal(await readTextOrThrowOversize(new Response('a'.repeat(100)), opts), 'a'.repeat(100));
    assert.equal((await readTextOrThrowOversize(new Response('a'.repeat(500)), { ...opts, byteCap: Infinity })).length, 500);
});
