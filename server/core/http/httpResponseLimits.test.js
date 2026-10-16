const { test } = require('node:test');
const assert = require('node:assert');
const { HTTP_RESPONSE_CAP, MAX_BYTES_PER_CHAR, readBodyBounded } = require('./httpResponseLimits');

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
