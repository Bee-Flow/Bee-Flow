// @typecheck
/**
 * BFSF-460: defaultFetchHttp (the code step's ctx.http bridge) reads the
 * response through readBodyBounded, so an endless body is cut at the cap and
 * its stream cancelled instead of being buffered with `await resp.text()`.
 *
 * safeFetch is replaced through defaultFetchHttp's fetchImpl seam; nothing touches the network.
 * Run: node --test server/automation/codeSandbox.boundedRead.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

let nextResponse = null;
const fetchImpl = async () => nextResponse;
const { defaultFetchHttp } = require('./codeSandbox');
const { MAX_BYTES_PER_CHAR } = require('./httpResponseLimits');

function endlessStream() {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream({
        pull(controller) { state.pulled++; controller.enqueue(new Uint8Array(1024).fill(97)); },
        cancel() { state.cancelled = true; },
    });
    return { state, resp: new Response(body, { headers: { 'content-type': 'text/plain' } }) };
}

test('an endless body is truncated at responseCap and the stream is cancelled', async () => {
    const responseCap = 5000;
    const s = endlessStream();
    nextResponse = s.resp;
    const r = await defaultFetchHttp('https://ok.test/endless', {}, { responseCap, fetchImpl });
    assert.equal(r.truncated, true);
    assert.equal(r.body.length, responseCap);
    assert.equal(r.status, 200);
    assert.ok(s.state.cancelled, 'stream cancelled');
    assert.ok(s.state.pulled * 1024 <= responseCap * MAX_BYTES_PER_CHAR + 64 * 1024, `pulled ${s.state.pulled} KiB`);
});

test('a small body comes back whole and untruncated', async () => {
    nextResponse = new Response('{"a":1}', { headers: { 'content-type': 'application/json' } });
    const r = await defaultFetchHttp('https://ok.test/small', {}, { fetchImpl });
    assert.deepEqual({ body: r.body, truncated: r.truncated }, { body: '{"a":1}', truncated: false });
});
