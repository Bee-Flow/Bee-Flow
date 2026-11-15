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
const { fetchWindmillExport, fetchFlowRuns, openWindmill, WindmillRemoteError } = require('./windmillRemote.mts');

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

// ── The runs of one flow (PLAN B6) ───────────────────────────────────────

const JOB_A = '018f6a2e-0000-7000-8000-00000000000a';
const JOB_B = '018f6a2e-0000-7000-8000-00000000000b';
const STEP_JOB = '018f6a2e-0000-7000-8000-0000000000c1';

/** A Windmill with two finished runs of f/a/flow; run A has a finished step `vat` and a failed step `label`. */
function windmillWithRuns({ pad = 0 } = {}) {
    const calls = [];
    const answer = (status, text) => ({
        ok: status < 400, status,
        headers: { get: () => null },
        body: new ReadableStream({ start(c) { if (text) c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
    });
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const u = new URL(url);
        const p = u.pathname;
        if (p === '/api/w/main/jobs/completed/list') return answer(200, JSON.stringify([{ id: JOB_A }, { id: JOB_B }, { id: '../../etc' }]));
        if (p === `/api/w/main/jobs_u/completed/get/${JOB_A}`) {
            return answer(200, JSON.stringify({
                id: JOB_A, success: true, args: { net: 10, note: 'x'.repeat(pad) },
                flow_status: { modules: [{ id: 'vat', type: 'Success', job: STEP_JOB }, { id: 'label', type: 'Failure', job: STEP_JOB }, { id: 'other', type: 'Success', job: STEP_JOB }] },
            }));
        }
        if (p === `/api/w/main/jobs_u/completed/get/${JOB_B}`) return answer(200, JSON.stringify({ id: JOB_B, success: false, args: { net: 3 } }));
        if (p === `/api/w/main/jobs_u/completed/get_result/${STEP_JOB}`) return answer(200, JSON.stringify({ net: 10, gross: 12.1 }));
        return answer(404, '');
    };
    return { fetchImpl, calls };
}

test('fetchFlowRuns: the documented job paths, newest first, inputs and the asked step results', async () => {
    const { fetchImpl, calls } = windmillWithRuns();
    const session = openWindmill(SRC, { maxBytes: 0, maxFlows: 0, maxTotalBytes: 0 }, { fetchImpl });
    const runs = await fetchFlowRuns(session, 'f/a/flow', 5, { moduleIds: new Set(['vat', 'label']) });
    assert.deepStrictEqual(runs.map((r) => [r.id, r.success]), [[JOB_A, true], [JOB_B, false]], 'a job id that is not one is never requested');
    assert.deepStrictEqual(runs[0].args, { net: 10, note: '' });
    assert.deepStrictEqual([...runs[0].stepResults.entries()], [['vat', { net: 10, gross: 12.1 }]], 'only finished steps that were asked for');
    const list = new URL(calls[0].url);
    assert.strictEqual(list.pathname, '/api/w/main/jobs/completed/list');
    assert.strictEqual(list.searchParams.get('script_path_exact'), 'f/a/flow');
    assert.strictEqual(list.searchParams.get('job_kinds'), 'flow');
    assert.strictEqual(list.searchParams.get('has_null_parent'), 'true');
    assert.strictEqual(list.searchParams.get('per_page'), '5');
    assert.strictEqual(calls.length, 4, 'list, two runs, one step result');
    for (const c of calls) {
        assert.ok(!c.url.includes(SRC.token), 'the token is never in a URL');
        assert.strictEqual(c.init.headers.authorization, `Bearer ${SRC.token}`);
    }
});

test('fetchFlowRuns: a path the list filter would read as several, or n = 0, asks nothing', async () => {
    const { fetchImpl, calls } = windmillWithRuns();
    const session = openWindmill(SRC, { maxBytes: 0, maxFlows: 0, maxTotalBytes: 0 }, { fetchImpl });
    assert.deepStrictEqual(await fetchFlowRuns(session, 'f/a/one,f/a/two', 5), []);
    assert.deepStrictEqual(await fetchFlowRuns(session, '!f/a/one', 5), []);
    assert.deepStrictEqual(await fetchFlowRuns(session, 'f/a/flow', 0), []);
    assert.strictEqual(calls.length, 0);
});

test('fetchFlowRuns: the run reads count against the same budget as the export read', async () => {
    const zip = (await require('../../automation/importers/windmill/goldenFixtures.mjs').inputOf('native-trigger-bundle')).data;
    const w = windmillWithRuns({ pad: 4000 });
    const fetchImpl = async (url, init) => {
        if (url.includes('workspaces/tarball')) return { ok: true, status: 200, headers: { get: () => null }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(zip)); c.close(); } }) };
        return w.fetchImpl(url, init);
    };
    // Room for the archive and the list, not for a run of 4 kB on top.
    const limits = { maxBytes: 0, maxFlows: 0, maxTotalBytes: zip.length + 300 };
    const session = openWindmill(SRC, limits, { fetchImpl });
    const exported = await fetchWindmillExport(SRC, limits, { session });
    assert.strictEqual(exported.input.kind, 'zip');
    await assert.rejects(fetchFlowRuns(session, 'f/a/flow', 5), (e) => e instanceof WindmillRemoteError && e.code === 'too_large');
    // A fresh session with the same limits reads the runs: the budget is per session.
    const fresh = openWindmill(SRC, limits, { fetchImpl: w.fetchImpl });
    assert.strictEqual((await fetchFlowRuns(fresh, 'f/a/flow', 1)).length, 1);
});

test('fetchFlowRuns: an answer that is not a job list is not_windmill; a refused token is unauthorized', async () => {
    const answer = (status, text) => ({ ok: status < 400, status, headers: { get: () => null }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }) });
    const notList = openWindmill(SRC, { maxBytes: 0, maxFlows: 0 }, { fetchImpl: async () => answer(200, '{"error":"x"}') });
    await assert.rejects(fetchFlowRuns(notList, 'f/a/flow', 5), (e) => e.code === 'not_windmill');
    const refused = openWindmill(SRC, { maxBytes: 0, maxFlows: 0 }, { fetchImpl: async () => answer(403, `no ${SRC.token}`) });
    await assert.rejects(fetchFlowRuns(refused, 'f/a/flow', 5), (e) => e.code === 'unauthorized' && !e.message.includes(SRC.token));
});
