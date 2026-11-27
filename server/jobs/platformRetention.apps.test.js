/**
 * The App Studio (module "apps") passes of jobs/platformRetention.js: the action-run prune and
 * the run log, under their own advisory lock, with the policy knobs of
 * stores/studioAppData/runPolicy.mts. Moved out of platformRetention.test.js, unchanged: they
 * need the module's run policy, so they belong to the module.
 *
 * Run: cd server && node --test jobs/platformRetention.apps.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const job = require('./platformRetention');

test.after(() => job._setDeps(null));

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
