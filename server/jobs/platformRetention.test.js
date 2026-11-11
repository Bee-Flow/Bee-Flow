/**
 * BFSF-439 — monitoring retention and the PII scan-ledger prune run on their
 * own, ungated job, not on the automation runner's module-gated tick.
 *
 * What is pinned here: one pass reaches both halves; a failing monitoring pass
 * does not skip the ledger prune; a lock another pod holds means no prune; and
 * the lock is released after a prune. Dependencies are injected through
 * _setDeps, so no store and no pool is ever loaded.
 *
 * Run: cd server && node --test jobs/platformRetention.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const job = require('./platformRetention');

function harness({ locked = true, monitoringThrows = false, scanPruneThrows = false } = {}) {
    const calls = { monitoring: 0, prune: [], queries: [], released: 0, suggestionScans: 0, suggestionFeedback: 0 };
    const logs = [];
    const record = (level) => (...args) => { logs.push({ level, msg: args.join(' ') }); };
    job._setDeps({
        pool: {
            connect: async () => ({
                query: async (sql, params) => {
                    calls.queries.push({ sql, params });
                    return { rows: [{ locked }] };
                },
                release() { calls.released += 1; },
            }),
        },
        monitoringRetentionPass: async () => {
            calls.monitoring += 1;
            if (monitoringThrows) throw new Error('monitoring store unreachable');
            return { deleted: {} };
        },
        pruneScanLedger: async (opts) => { calls.prune.push(opts); return { deleted: 3 }; },
        ledgerKeyVersion: 7,
        pruneSuggestionScans: async () => {
            calls.suggestionScans += 1;
            if (scanPruneThrows) throw new Error('scan cache unreachable');
            return 2;
        },
        pruneSuggestionFeedback: async () => { calls.suggestionFeedback += 1; return 0; },
        pruneDocumentSuggestions: async () => { calls.documentSuggestions = (calls.documentSuggestions || 0) + 1; return 4; },
        log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
    });
    return { calls, logs };
}

test.after(() => job._setDeps(null));

test('one pass runs the monitoring retention and the ledger prune', async () => {
    const { calls } = harness();
    await job.runOnce();
    assert.strictEqual(calls.monitoring, 1, 'monitoring retention did not run');
    assert.strictEqual(calls.prune.length, 1, 'the scan-ledger prune did not run');
    assert.strictEqual(calls.prune[0].keyVersion, 7);
    assert.ok(calls.prune[0].maxRows >= 1000, 'the ledger cap lost its floor');
});

test('a failing monitoring pass does not skip the ledger prune', async () => {
    const { calls, logs } = harness({ monitoringThrows: true });
    await job.runOnce();
    assert.strictEqual(calls.prune.length, 1, 'the prune was skipped after a monitoring failure');
    assert.ok(logs.some(l => l.level === 'error' && /monitoring retention failed/.test(l.msg)));
});

test('another pod holding the ledger lock means no prune here', async () => {
    const { calls } = harness({ locked: false });
    await job.runOnce();
    assert.strictEqual(calls.monitoring, 1, 'the monitoring pass takes its own lock and must still be called');
    assert.strictEqual(calls.prune.length, 0, 'pruned without holding the advisory lock');
    assert.ok(!calls.queries.some(q => /pg_advisory_unlock/.test(q.sql)), 'released a lock it never held');
    assert.strictEqual(calls.released, 1, 'the pool client was not released');
});

test('the ledger prune takes its own advisory lock and releases it', async () => {
    const { calls } = harness();
    await job.runOnce();
    const lock = calls.queries.find(q => /pg_try_advisory_lock/.test(q.sql));
    const unlock = calls.queries.find(q => /pg_advisory_unlock/.test(q.sql));
    assert.deepStrictEqual(lock.params, [job.LEDGER_PRUNE_LOCK_KEY]);
    assert.deepStrictEqual(unlock.params, [job.LEDGER_PRUNE_LOCK_KEY]);
    assert.strictEqual(calls.released, 1);
});

test('one pass also prunes the suggestion scan cache and feedback', async () => {
    const { calls, logs } = harness();
    await job.runOnce();
    assert.strictEqual(calls.suggestionScans, 1, 'the suggestion scan cache was not pruned');
    assert.strictEqual(calls.suggestionFeedback, 1, 'the suggestion feedback was not pruned');
    assert.ok(logs.some(l => l.level === 'info' && /pruned 2 suggestion scan row/.test(l.msg)));
});

test('a failing scan-cache prune does not skip the feedback prune', async () => {
    const { calls, logs } = harness({ scanPruneThrows: true });
    await job.runOnce();
    assert.strictEqual(calls.suggestionFeedback, 1);
    assert.ok(logs.some(l => l.level === 'warn' && /suggestion scan prune failed/.test(l.msg)));
});

test('the suggestion prunes run even when another pod holds the ledger lock', async () => {
    const { calls } = harness({ locked: false });
    await job.runOnce();
    assert.strictEqual(calls.suggestionScans, 1);
    assert.strictEqual(calls.suggestionFeedback, 1);
});

test('start() mounts one boot pass and one hourly interval, and stop() clears both', () => {
    harness();
    const realSetInterval = globalThis.setInterval;
    const realSetTimeout = globalThis.setTimeout;
    const realClearInterval = globalThis.clearInterval;
    const realClearTimeout = globalThis.clearTimeout;
    const mounted = [];
    const cleared = [];
    const handle = (kind, delay) => { const h = { kind, delay, unref() { return this; } }; mounted.push(h); return h; };
    globalThis.setInterval = (_fn, delay) => handle('interval', delay);
    globalThis.setTimeout = (_fn, delay) => handle('timeout', delay);
    globalThis.clearInterval = (h) => cleared.push(h);
    globalThis.clearTimeout = (h) => cleared.push(h);
    try {
        job.start();
        job.start(); // idempotent
        job.stop();
    } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearInterval = realClearInterval;
        globalThis.clearTimeout = realClearTimeout;
    }
    assert.deepStrictEqual(mounted.map(h => h.kind).sort(), ['interval', 'timeout']);
    assert.strictEqual(mounted.find(h => h.kind === 'interval').delay, 60 * 60 * 1000);
    assert.strictEqual(cleared.length, 2, 'stop() left a timer running');
});

test('a pass also purges resolved document suggestions', async () => {
    const { calls } = harness();
    await job.runOnce();
    assert.strictEqual(calls.documentSuggestions, 1);
});

test('the action-run prune runs under its own lock with the policy knobs; a failure skips nothing; 0/0 skips it', async () => {
    const queries = [];
    const runs = [];
    let throwRuns = false;
    const logs = [];
    const deps = {
        pool: { connect: async () => ({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ locked: true }] }; }, release() {} }) },
        monitoringRetentionPass: async () => ({ deleted: {} }),
        pruneScanLedger: async () => ({ deleted: 0 }),
        ledgerKeyVersion: 1,
        pruneSuggestionScans: async () => 0,
        pruneSuggestionFeedback: async () => 0,
        pruneDocumentSuggestions: async () => 0,
        pruneStudioActionRuns: async (opts) => { runs.push(opts); if (throwRuns) throw new Error('runs unreachable'); return { nulled: 2, deleted: 1 }; },
        log: { debug() {}, info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error() {} },
    };
    job._setDeps(deps);
    await job.runOnce();
    assert.deepStrictEqual(runs, [{ resultTtlHours: 24, retentionDays: 30, batch: 5000 }]);
    assert.ok(queries.some((q) => /pg_try_advisory_lock/.test(q.sql) && q.params[0] === job.ACTION_RUN_PRUNE_LOCK_KEY));
    assert.ok(queries.some((q) => /pg_advisory_unlock/.test(q.sql) && q.params[0] === job.ACTION_RUN_PRUNE_LOCK_KEY));
    // A run on hold the pass ends withdraws the approval request it asked, as a cancel does.
    const released = [];
    const prune = deps.pruneStudioActionRuns;
    deps.releaseStudioWait = async (...a) => { released.push(a); };
    deps.pruneStudioActionRuns = async (opts) => { await opts.onEndedWait({ appId: 'app_1', waitKind: 'approval', waitRef: 'apr_1' }); return { nulled: 0, deleted: 0, expired: 1 }; };
    job._setDeps(deps);
    await job.runOnce();
    assert.deepStrictEqual(released, [['app_1', 'approval', 'apr_1', 'The run that asked was ended before a decision.']]);
    deps.pruneStudioActionRuns = prune;
    throwRuns = true;
    job._setDeps(deps);
    await job.runOnce();
    assert.ok(logs.some((l) => /action-run prune failed/.test(l)));
    process.env.STUDIO_APP_RUN_RETENTION_DAYS = '0';
    process.env.STUDIO_APP_RUN_RESULT_TTL_HOURS = '0';
    try {
        runs.length = 0;
        job._setDeps(deps);
        await job.runOnce();
        assert.deepStrictEqual(runs, [], 'both knobs 0: nothing pruned');
    } finally {
        delete process.env.STUDIO_APP_RUN_RETENTION_DAYS;
        delete process.env.STUDIO_APP_RUN_RESULT_TTL_HOURS;
        job._setDeps(null);
    }
});

test('the run log pass closes idle browser runs and applies the per-app ceiling under the same lock; env knobs reach it', async () => {
    const queries = [];
    const runLog = [];
    const logs = [];
    const deps = {
        pool: { connect: async () => ({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ locked: true }] }; }, release() {} }) },
        monitoringRetentionPass: async () => ({ deleted: {} }),
        pruneScanLedger: async () => ({ deleted: 0 }),
        ledgerKeyVersion: 1,
        pruneSuggestionScans: async () => 0,
        pruneSuggestionFeedback: async () => 0,
        pruneDocumentSuggestions: async () => 0,
        pruneStudioActionRuns: async () => ({ nulled: 0, deleted: 0 }),
        pruneStudioRunLog: async (opts) => { runLog.push(opts); return { closed: 3, overflow: 1 }; },
        log: { debug() {}, info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error() {} },
    };
    process.env.STUDIO_APP_RUN_LOG_MAX_RUNS_PER_APP = '250';
    process.env.STUDIO_APP_RUN_RETENTION_DAYS = '0';
    process.env.STUDIO_APP_RUN_RESULT_TTL_HOURS = '0';
    try {
        job._setDeps(deps);
        await job.runOnce();
        assert.deepStrictEqual(runLog, [{ maxPerApp: 250, idleMs: 60_000, staleMs: 900_000, batch: 5000 }], 'runs even when the age knobs are 0 (keep forever)');
        assert.ok(logs.some((l) => /3 idle run\(s\) closed, 1 run\(s\) over the per-app ceiling/.test(l)));
        assert.ok(queries.some((q) => /pg_try_advisory_lock/.test(q.sql) && q.params[0] === job.ACTION_RUN_PRUNE_LOCK_KEY));
    } finally {
        delete process.env.STUDIO_APP_RUN_LOG_MAX_RUNS_PER_APP;
        delete process.env.STUDIO_APP_RUN_RETENTION_DAYS;
        delete process.env.STUDIO_APP_RUN_RESULT_TTL_HOURS;
        job._setDeps(null);
    }
});
