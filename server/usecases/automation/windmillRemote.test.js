/**
 * Reading a standalone Windmill (usecases/automation/windmillRemote.mts): the
 * bytes of every answer count against one budget for the whole read, so the
 * flow-by-flow fallback cannot hold more than the import allows in total.
 *
 * Run: cd server && node --test usecases/automation/windmillRemote.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { fetchWindmillExport, WindmillRemoteError } = require('./windmillRemote.mts');

const SRC = { baseUrl: 'https://windmill.example.com', workspace: 'main', token: 'wm-test-token-not-a-secret-1234' };

/** A Windmill without the archive: a list of `n` flows, each answering `flowBytes` bytes of JSON. */
function fakeWindmill(n, flowBytes) {
    const calls = [];
    const answer = (status, text) => ({
        ok: status < 400, status,
        headers: { get: () => null },
        body: new ReadableStream({ start(c) { if (text) c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
    });
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.includes('workspaces/tarball')) return answer(404, '');
        if (url.includes('flows/list')) return answer(200, JSON.stringify(Array.from({ length: n }, (_, i) => ({ path: `f/a/flow${i}` }))));
        const pad = 'x'.repeat(Math.max(0, flowBytes - 30));
        return answer(200, JSON.stringify({ summary: pad, value: { modules: [] } }));
    };
    return { fetchImpl, calls };
}

test('the flow-by-flow read stops at the total budget with too_large', async () => {
    const { fetchImpl, calls } = fakeWindmill(10, 1000);
    await assert.rejects(
        fetchWindmillExport(SRC, { maxBytes: 5000, maxFlows: 0, maxTotalBytes: 4000 }, { fetchImpl }),
        (e) => e instanceof WindmillRemoteError && e.code === 'too_large',
    );
    assert.ok(calls.length < 12, `stopped early (${calls.length} requests)`);
});

test('within the budget every flow is read; 0 means no total budget', async () => {
    const a = fakeWindmill(3, 500);
    const within = await fetchWindmillExport(SRC, { maxBytes: 5000, maxFlows: 0, maxTotalBytes: 100_000 }, { fetchImpl: a.fetchImpl });
    assert.strictEqual(within.input.value.length, 3);
    const b = fakeWindmill(3, 500);
    const unlimited = await fetchWindmillExport(SRC, { maxBytes: 0, maxFlows: 0, maxTotalBytes: 0 }, { fetchImpl: b.fetchImpl });
    assert.strictEqual(unlimited.input.value.length, 3);
});
