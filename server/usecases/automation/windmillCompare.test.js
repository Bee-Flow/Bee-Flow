/**
 * The side-by-side comparison of a Windmill import (usecases/automation/windmillCompare.mts)
 * with its stores and runner as doubles; the real runner on PGlite is in
 * windmillCompare.pg.test.js.
 *
 *   - shapes are key paths: a key that could be data reads `*`, never a value;
 *   - the summary that is stored holds no value of a run's input or results
 *     (a secret-looking and a personal-looking value are checked), and nothing
 *     is logged with them;
 *   - every dry run is deleted after it is summarised, unless it is kept as a
 *     golden run ("Save the runs as test cases"), whose input is scrubbed first;
 *   - AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS=0 switches the comparison off;
 *   - a spent byte budget or a refused token stops the reads for later flows.
 *
 * Run: cd server && node --test usecases/automation/windmillCompare.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { keyPaths, shapeDiff, compareImported, compareLimits, counterparts } = require('./windmillCompare.mts');
const { WindmillRemoteError } = require('./windmillRemote.mts');
const log = require('../../telemetry/log');

// A random, token-shaped value, made at run time so no fixture looks like a real key.
const SECRET = `${require('node:crypto').randomBytes(24).toString('base64url')}7q`;
const PERSON = 'jan.jansen@example.com';

const FLOW = {
    flowPath: 'f/fin/vat',
    payload: { kind: 'form', event: null },
    report: { modules: [{ wmId: 'vat', stepIds: ['vat'] }, { wmId: 'label', stepIds: ['label'] }] },
    outputs: [{ wmId: 'vat', stepId: 'vat', path: ['result'] }],
};
const STORED_REPORT = { modules: [{ wmId: 'vat', stepIds: ['vat_1a2b3c'] }, { wmId: 'label', stepIds: ['label_4d5e6f'] }] };

/** Two Windmill runs: one whose input reaches the end in Bee Flow, one that makes a step fail. */
function windmillRuns() {
    return [
        {
            id: '018f6a2e-0000-7000-8000-00000000000a', success: true,
            args: { net: 10, apiKey: SECRET, email: PERSON },
            stepResults: new Map([['vat', { net: 10, gross: 12.1, customer: { email: PERSON }, byEmail: { [PERSON]: 1 }, token: SECRET }]]),
        },
        {
            id: '018f6a2e-0000-7000-8000-00000000000b', success: false,
            args: { net: -1, email: PERSON },
            stepResults: new Map(),
        },
    ];
}

/** Doubles of the stores and the runner; the dry run fails when net < 0. */
function doubles(over = {}) {
    const calls = { dryRuns: [], deleted: [], stored: [], goldens: [], noted: [], fetched: [] };
    let n = 0;
    const deps = {
        fetchRuns: async (path, count, moduleIds) => { calls.fetched.push({ path, count, moduleIds: [...moduleIds] }); return windmillRuns(); },
        getAutomation: async (id) => ({ id, version: 4 }),
        getImport: async () => ({ report: STORED_REPORT }),
        dryRun: async (automation, payload, userId, onRunCreated) => {
            n += 1;
            const run = { id: `run-${n}`, automationId: automation.id, status: payload.net < 0 ? 'error' : 'success', version: 4, mode: 'dry_run' };
            onRunCreated(run);
            calls.dryRuns.push({ payload, userId });
            return run;
        },
        getRunSteps: async (runId) => {
            const failed = calls.dryRuns[Number(runId.slice(4)) - 1].payload.net < 0;
            return [
                failed
                    ? { stepId: 'vat_1a2b3c', status: 'error', error: `bad input ${PERSON}`, errorInfo: { code: 'code_step_failed', message: PERSON } }
                    : { stepId: 'vat_1a2b3c', status: 'success', output: { result: { net: 10, gross: 12.1, extra: SECRET }, _dryRun: true } },
                { stepId: 'label_4d5e6f', status: 'error', error: SECRET, errorClass: `weird ${PERSON}` },
            ];
        },
        deleteDryRun: async (automationId, runId) => { calls.deleted.push(runId); },
        setComparison: async (automationId, c) => { calls.stored.push({ automationId, c }); },
        noteDryRun: async (a, run) => { calls.noted.push(run.id); },
        saveGolden: async (a, run, label) => {
            calls.goldens.push({ runId: run.id, label });
            return run.status === 'success' ? { golden: true, runId: run.id, reason: null } : { golden: false, runId: null, reason: 'golden_needs_success' };
        },
        ...over,
    };
    return { deps, calls };
}

const RESULTS = [{ path: 'f/fin/vat', ok: true, automationId: 'a1' }];
const input = (over = {}) => ({ flows: [FLOW], results: RESULTS, limits: { runs: 5, flows: 20 }, saveAsTests: false, userId: 'u1', ...over });

function captureLogs() {
    const lines = [];
    const original = { warn: log.warn, info: log.info, error: log.error, debug: log.debug };
    for (const k of Object.keys(original)) log[k] = (...a) => { lines.push(a.map(String).join(' ')); };
    return { lines, restore: () => Object.assign(log, original) };
}

test('keyPaths: names, nesting and lists; a key that could be data reads *, a map collapses', () => {
    assert.deepStrictEqual([...keyPaths({ a: { b: 1 }, list: [{ id: 1 }], _marker: true })].sort(), ['a', 'a.b', 'list', 'list[]', 'list[].id']);
    assert.deepStrictEqual([...keyPaths({ [PERSON]: 1 })], ['*']);
    const map = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, { v: i }]));
    assert.deepStrictEqual([...keyPaths({ m: map })].sort(), ['m', 'm.*', 'm.*.v']);
    assert.deepStrictEqual([...keyPaths('a plain value')], []);
});

test('shapeDiff lists what Bee Flow lacks and what only Bee Flow has, sorted', () => {
    assert.deepStrictEqual(shapeDiff({ net: 1, gross: 2, currency: 'EUR' }, { net: 1, gross: 2, rounded: true }), { missing: ['currency'], extra: ['rounded'] });
    assert.deepStrictEqual(shapeDiff({ a: [1] }, { a: [2] }), { missing: [], extra: [] });
});

test('counterparts: the stored (re-keyed) step id and the path in its output', () => {
    assert.deepStrictEqual([...counterparts(FLOW, STORED_REPORT)], [['vat', { stepId: 'vat_1a2b3c', path: ['result'] }]]);
});

test('the stored summary holds statuses, step ids, codes and key paths, never a value of the run', async () => {
    const { deps, calls } = doubles();
    const logs = captureLogs();
    let out;
    try { out = await compareImported(input(), deps); } finally { logs.restore(); }
    assert.strictEqual(calls.stored.length, 1);
    const c = calls.stored[0].c;
    assert.strictEqual(c.status, 'done');
    assert.strictEqual(c.requested, 5);
    assert.deepStrictEqual(c.scenarios.map((s) => [s.windmillRunId.slice(-1), s.windmillSuccess, s.reachedEnd]), [['a', true, true], ['b', false, false]]);
    const [ok, failed] = c.scenarios;
    assert.deepStrictEqual(ok.failedSteps, [{ stepId: 'label_4d5e6f', code: 'step_failed' }], 'an error class that is not a plain code is not kept');
    assert.deepStrictEqual(ok.shapeDiffs, [{ stepId: 'vat_1a2b3c', wmId: 'vat', simulated: true, missing: ['byEmail', 'byEmail.*', 'customer', 'customer.email', 'token'], extra: ['extra'] }]);
    assert.deepStrictEqual(failed.failedSteps, [{ stepId: 'vat_1a2b3c', code: 'code_step_failed' }, { stepId: 'label_4d5e6f', code: 'step_failed' }]);
    const text = JSON.stringify({ stored: calls.stored, out: [...out.entries()], logs: logs.lines });
    assert.ok(!text.includes(SECRET), 'no secret-looking value');
    assert.ok(!text.includes(PERSON), 'no personal-looking value');
    assert.ok(!text.includes('12.1'), 'no result value');
    // Read with the step ids of the converter; only the steps with a counterpart.
    assert.deepStrictEqual(calls.fetched, [{ path: 'f/fin/vat', count: 5, moduleIds: ['vat'] }]);
    // Without "save": the dry run gets the input as it was, and every run is deleted.
    assert.strictEqual(calls.dryRuns[0].payload.apiKey, SECRET);
    assert.deepStrictEqual(calls.deleted, ['run-1', 'run-2']);
    assert.deepStrictEqual(calls.goldens, []);
    // The activation gate hears of the clean dry run only (its own version rule decides).
    assert.deepStrictEqual(calls.noted, ['run-1']);
});

test('"Save the runs as test cases": the input is scrubbed first, a run that reached the end is kept as a golden run', async () => {
    const { deps, calls } = doubles();
    await compareImported(input({ saveAsTests: true }), deps);
    assert.notStrictEqual(calls.dryRuns[0].payload.apiKey, SECRET, 'the secret-shaped value is scrubbed before the dry run');
    assert.strictEqual(calls.dryRuns[0].payload.net, 10);
    assert.deepStrictEqual(calls.goldens.map((g) => g.runId), ['run-1', 'run-2']);
    assert.match(calls.goldens[0].label, /^Windmill run 018f6a2e$/);
    assert.deepStrictEqual(calls.deleted, ['run-2'], 'the golden run stays; the one that failed goes');
    const [ok, failed] = calls.stored[0].c.scenarios;
    assert.deepStrictEqual(ok.saved, { golden: true, runId: 'run-1', reason: null });
    assert.deepStrictEqual(failed.saved, { golden: false, runId: null, reason: 'golden_needs_success' });
    assert.strictEqual(calls.stored[0].c.savedAsTests, true);
});

test('a dry run that throws after its row was written is deleted, and only its code is logged', async () => {
    const { deps, calls } = doubles({
        dryRun: async (automation, payload, userId, onRunCreated) => {
            onRunCreated({ id: 'run-x' });
            throw Object.assign(new Error(`boom ${SECRET}`), { code: 'runner_crashed' });
        },
    });
    const logs = captureLogs();
    try { await compareImported(input({ saveAsTests: true }), deps); } finally { logs.restore(); }
    assert.deepStrictEqual(calls.deleted, ['run-x', 'run-x']);
    const s = calls.stored[0].c.scenarios[0];
    assert.strictEqual(s.status, 'not_started');
    assert.strictEqual(s.reachedEnd, false);
    assert.ok(logs.lines.some((l) => l.includes('runner_crashed')));
    assert.ok(!logs.lines.join('\n').includes(SECRET));
});

test('AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS=0 switches the comparison off; the default is 5, at most 100', async () => {
    const saved = process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS;
    try {
        process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS = '0';
        const off = compareLimits();
        assert.strictEqual(off.runs, 0);
        const { deps, calls } = doubles();
        const out = await compareImported(input({ limits: off }), deps);
        assert.strictEqual(out.size, 0);
        assert.deepStrictEqual([calls.fetched.length, calls.dryRuns.length, calls.stored.length], [0, 0, 0]);
        delete process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS;
        assert.deepStrictEqual(compareLimits(), { runs: 5, flows: 20 });
        process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS = '500';
        assert.strictEqual(compareLimits().runs, 100);
    } finally {
        if (saved === undefined) delete process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS; else process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS = saved;
    }
});

test('a spent budget stops the reads for the flows after it; the flow cap skips the rest; no runs is said so', async () => {
    const results = [
        { path: 'f/fin/vat', ok: true, automationId: 'a1' },
        { path: 'f/fin/vat2', ok: true, automationId: 'a2' },
        { path: 'f/fin/failed', ok: false },
    ];
    const flows = [FLOW, { ...FLOW, flowPath: 'f/fin/vat2' }];
    const spent = doubles({ fetchRuns: async () => { throw new WindmillRemoteError('too_large'); } });
    await compareImported(input({ flows, results }), spent.deps);
    assert.deepStrictEqual(spent.calls.stored.map((s) => [s.automationId, s.c.status]), [['a1', 'budget_spent'], ['a2', 'budget_spent']]);

    const capped = doubles({ fetchRuns: async () => [] });
    await compareImported(input({ flows, results, limits: { runs: 5, flows: 1 } }), capped.deps);
    assert.deepStrictEqual(capped.calls.stored.map((s) => s.c.status), ['no_runs', 'skipped_flow_limit']);
});
