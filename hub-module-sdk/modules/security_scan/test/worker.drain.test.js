/**
 * Worker drain — the outbox drain tick, with a hand-rolled fake store/scanRunner/
 * driver so no Postgres or docker is touched. Covers:
 *   • empty claim → processed: 0
 *   • claimed job on a host with no docker → marked error 'docker_unavailable'
 *   • claimed job that runs to completion → marked completed with the report
 *   • the built-in's module-active gate is GONE (a drain runs even though the
 *     loader is the one that self-gates on isModuleActive)
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeWorker } = require('../server/src/worker');
const { makeHostMock } = require('./hostMock');

function fakeStore(overrides = {}) {
    const calls = { markFinished: [], markRunning: [], markCancelled: [], markRetryable: [] };
    return {
        _calls: calls,
        claimDueJobs: overrides.claimDueJobs || (async () => []),
        markRunning: async (id) => { calls.markRunning.push(id); return true; },
        markFinished: async (id, arg) => { calls.markFinished.push({ id, ...arg }); return true; },
        markCancelled: async (id) => { calls.markCancelled.push(id); return { ok: true }; },
        markRetryable: async (id, e) => { calls.markRetryable.push({ id, e }); },
        isCancelRequested: () => false,
        appendProgress: async () => {},
        getScan: async () => null,
    };
}

function fakeScanRunner(overrides = {}) {
    return {
        dockerAvailable: overrides.dockerAvailable || (async () => false),
        startAgentToolbox: overrides.startAgentToolbox || (async () => ({ zap: {}, exec: async () => ({ exitCode: 0 }), cleanup: async () => {} })),
        adoptToolbox: async () => null,
        registerActiveToolbox: () => {},
        unregisterActiveToolbox: () => {},
        killScan: async () => {},
        reapStaleRunners: async () => ({ reaped: 0 }),
    };
}

const PUBLIC_CLAIM = {
    scan_id: 's1', user_id: 'u1', organization_id: null,
    target_url: 'https://ok.example', engines: '[{"engine":"zap"}]',
    metadata: null, model_tier: 'thinking', aggression: 'passive',
    created_at: new Date().toISOString(),
};

test('drainOnce with an empty outbox does nothing', async () => {
    const host = makeHostMock();
    const store = fakeStore();
    const worker = makeWorker({ store, scanRunner: fakeScanRunner(), driver: { runAgentScan: async () => ({}) }, host });
    const r = await worker.drainOnce();
    assert.deepStrictEqual(r, { processed: 0 });
});

test('drainOnce marks a scan error when docker is unavailable (no host fallback)', async () => {
    const host = makeHostMock();
    const store = fakeStore({ claimDueJobs: async () => [PUBLIC_CLAIM] });
    const worker = makeWorker({
        store,
        scanRunner: fakeScanRunner({ dockerAvailable: async () => false }),
        driver: { runAgentScan: async () => { throw new Error('should not run without docker'); } },
        host,
    });

    const r = await worker.drainOnce();
    assert.strictEqual(r.processed, 1);
    assert.strictEqual(store._calls.markFinished.length, 1);
    const mf = store._calls.markFinished[0];
    assert.strictEqual(mf.id, 's1');
    assert.strictEqual(mf.status, 'error');
    assert.match(mf.error, /docker_unavailable/);
});

test('drainOnce runs a claimed scan to completion and persists the report', async () => {
    const host = makeHostMock();
    const store = fakeStore({ claimDueJobs: async () => [PUBLIC_CLAIM] });
    let ran = false;
    const driver = {
        runAgentScan: async (args) => {
            ran = true;
            assert.strictEqual(args.scanId, 's1');
            assert.strictEqual(args.targetUrl, 'https://ok.example');
            return { status: 'completed', reportJson: { ok: true }, reportWebpageId: 'wp-9', severitySummary: { high: 0 } };
        },
    };
    const worker = makeWorker({
        store,
        scanRunner: fakeScanRunner({ dockerAvailable: async () => true }),
        driver,
        host,
    });

    const r = await worker.drainOnce();
    assert.strictEqual(r.processed, 1);
    assert.ok(ran, 'driver.runAgentScan was invoked');
    assert.strictEqual(store._calls.markRunning[0], 's1');
    const mf = store._calls.markFinished[0];
    assert.strictEqual(mf.status, 'completed');
    assert.strictEqual(mf.reportWebpageId, 'wp-9');
    assert.deepStrictEqual(mf.reportJson, { ok: true });
});

test('drainOnce blocks a target that became private while queued', async () => {
    const host = makeHostMock();
    const privateClaim = { ...PUBLIC_CLAIM, scan_id: 's2', target_url: 'http://10.0.0.5' };
    const store = fakeStore({ claimDueJobs: async () => [privateClaim] });
    const worker = makeWorker({
        store,
        scanRunner: fakeScanRunner({ dockerAvailable: async () => true }),
        driver: { runAgentScan: async () => { throw new Error('should not run for private target'); } },
        host,
    });

    await worker.drainOnce();
    const mf = store._calls.markFinished[0];
    assert.strictEqual(mf.status, 'error');
    assert.match(mf.error, /private\/internal address/);
});

test('makeWorker requires its four collaborators', () => {
    assert.throws(() => makeWorker({}), /store, scanRunner, driver and host are required/);
});
