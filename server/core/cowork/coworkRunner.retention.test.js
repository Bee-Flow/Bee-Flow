/**
 * De retentiesweep-bedrading in de cowork-runner: hetzelfde configpatroon als
 * jobs/runRetention.js (COWORK_RUN_RETENTION_DAYS, default 90, 0 = uit) en
 * dezelfde begrensde batchlus — doorgaan zolang een batch vol terugkomt,
 * stoppen bij een korte. Een storefout laat de pass niet klappen: retentie is
 * huishouden, de volgende uurpass haalt het in.
 *
 * Run: node --test --test-force-exit core/cowork/coworkRunner.retention.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { installResolveStub, evictModule } = require('../../testUtils/stubRequire');

const pruneCalls = [];
let script = []; // per aanroep: aantal verwijderde rijen, of een Error om te gooien

const restore = installResolveStub({
    '../../stores/coworkStore': {
        reapStaleRuns: async () => 0,
        getDueSchedules: async () => [],
        deleteRunsOlderThan: async (cutoff, opts) => {
            pruneCalls.push({ cutoff, opts });
            const step = script.shift();
            if (step instanceof Error) throw step;
            return step ?? 0;
        },
    },
    '../aiTaskRunner': { executeTask: async () => {} },
});

const RUNNER_PATH = path.join(__dirname, 'coworkRunner.js');

// RETENTION_DAYS wordt bij load uit de env gelezen (net als runRetention.js),
// dus per scenario de module vers laden. Alle timers in de module zijn
// unref'd, dus herladen lekt geen levend proces.
function loadRunner(days) {
    evictModule(RUNNER_PATH);
    if (days === undefined) delete process.env.COWORK_RUN_RETENTION_DAYS;
    else process.env.COWORK_RUN_RETENTION_DAYS = String(days);
    return require('./coworkRunner');
}

const DAY_MS = 24 * 60 * 60_000;

test('default venster is 90 dagen en de lus batcht tot een korte batch', async () => {
    const runner = loadRunner(undefined);
    assert.strictEqual(runner.RETENTION_DAYS, 90);

    pruneCalls.length = 0;
    script = [5000, 2]; // volle batch → nog een; korte batch → klaar
    const res = await runner.pruneOldRuns();

    assert.strictEqual(pruneCalls.length, 2);
    assert.strictEqual(res.deleted, 5002);
    for (const c of pruneCalls) assert.strictEqual(c.opts.limit, 5000);
    const age = Date.now() - Date.parse(pruneCalls[0].cutoff);
    assert.ok(Math.abs(age - 90 * DAY_MS) < 60_000, `cutoff hoort nu-90d te zijn (afwijking ${age - 90 * DAY_MS}ms)`);
});

test('het venster volgt COWORK_RUN_RETENTION_DAYS', async () => {
    const runner = loadRunner(7);
    assert.strictEqual(runner.RETENTION_DAYS, 7);

    pruneCalls.length = 0;
    script = [0];
    await runner.pruneOldRuns();

    assert.strictEqual(pruneCalls.length, 1);
    const age = Date.now() - Date.parse(pruneCalls[0].cutoff);
    assert.ok(Math.abs(age - 7 * DAY_MS) < 60_000);
});

test('0 schakelt de retentie uit — er wordt niets verwijderd', async () => {
    const runner = loadRunner(0);

    pruneCalls.length = 0;
    const res = await runner.pruneOldRuns();

    assert.strictEqual(res.disabled, true);
    assert.strictEqual(res.deleted, 0);
    assert.strictEqual(pruneCalls.length, 0, 'de store wordt niet eens aangeraakt');
});

test('een storefout laat de pass niet klappen', async () => {
    const runner = loadRunner(90);

    pruneCalls.length = 0;
    script = [new Error('db down')];
    const res = await runner.pruneOldRuns();

    assert.strictEqual(res.deleted, 0, 'de fout wordt geslikt en gemeld, niet gegooid');
});

test.after(() => {
    delete process.env.COWORK_RUN_RETENTION_DAYS;
    evictModule(RUNNER_PATH);
    restore();
});
