/**
 * The side-by-side comparison end to end on a real Postgres (PGlite behind the
 * real db.js), with the real runner: a Windmill flow is converted and
 * committed, its last runs are read from a fake Windmill through the import's
 * own session (fetchFlowRuns), each run's input is re-mapped into the trigger
 * payload and the draft gets one dry run per run.
 *
 *   - the summary lands in the import report; the dry runs are gone afterwards;
 *   - a clean dry run of the stored version satisfies the activation gate's
 *     dry-run rule (its own noteDryRun), nothing else of the gate moves;
 *   - the report holds no value of the runs (a secret-looking and a personal-
 *     looking value are checked);
 *   - "Save the runs as test cases": the run that reached the end stays as a
 *     golden run, with its input scrubbed.
 *
 * Run: cd server && node --test usecases/automation/windmillCompare.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();

const automationStore = require('../../stores/automationStore');
const testingStore = require('../../stores/automationTestingStore');
const { inputOf } = require('../../automation/importers/windmill/goldenFixtures.mjs');
const { convertWindmill, commitWindmill } = require('./windmillImport.mts');
const { compareImported } = require('./windmillCompare.mts');
const { openWindmill, fetchFlowRuns } = require('./windmillRemote.mts');

const LIMITS = { maxBytes: 0, maxUnzippedBytes: 0, maxEntries: 0, maxFlows: 0, rpm: 0, briefPerItemChars: 6000, briefTotalChars: 40000 };
const ctx = {
    userId: 'u-importer',
    organizationId: 'org-import',
    importableDatatables: async () => [],
    permittedApps: async () => new Set(),
    kbFindings: async () => [],
};
// A random, token-shaped value, made at run time so no fixture looks like a real key.
const SECRET = `${require('node:crypto').randomBytes(24).toString('base64url')}7q`;
const PERSON = 'jan.jansen@example.com';
const FLOW_PATH = 'f/fixtures/ts-pure-shim.flow';
const RUN_OK = '018f6a2e-0000-7000-8000-00000000000a';
const RUN_TWO = '018f6a2e-0000-7000-8000-00000000000b';
const STEP_JOB = '018f6a2e-0000-7000-8000-0000000000c1';

before(async () => {
    await automationStore.initDB();
    // The runner's ports (code sandbox, output schemas, …), as boot registers them.
    require('../../automation/runnerPorts');
});
after(close);

/** A Windmill with two runs of the VAT flow; its `vat` step answered one field more than Bee Flow's. */
function fakeWindmill() {
    const calls = [];
    const answer = (text) => new Response(text, { status: 200 });
    const fetchImpl = async (url) => {
        calls.push(url);
        const p = new URL(url).pathname;
        if (p.endsWith('/jobs/completed/list')) return answer(JSON.stringify([{ id: RUN_OK }, { id: RUN_TWO }]));
        if (p.endsWith(`/jobs_u/completed/get/${RUN_OK}`)) {
            return answer(JSON.stringify({ id: RUN_OK, success: true, args: { net: 10, rate: 21, note: PERSON, apiKey: SECRET }, flow_status: { modules: [{ id: 'vat', type: 'Success', job: STEP_JOB }] } }));
        }
        if (p.endsWith(`/jobs_u/completed/get/${RUN_TWO}`)) return answer(JSON.stringify({ id: RUN_TWO, success: true, args: { net: 20, rate: 9 } }));
        if (p.endsWith(`/jobs_u/completed/get_result/${STEP_JOB}`)) return answer(JSON.stringify({ net: 10, gross: 12.1, currency: 'EUR', owner: PERSON }));
        return new Response('', { status: 404 });
    };
    return { fetchImpl, calls };
}

async function importAndCompare(saveAsTests) {
    const conv = await convertWindmill(await inputOf('ts-pure-shim.flow'), LIMITS);
    const results = await commitWindmill(conv, { select: null, sourceKind: 'windmill_api', limits: LIMITS, ctx });
    assert.ok(results[0].ok, results[0].error);
    const { fetchImpl, calls } = fakeWindmill();
    const session = openWindmill({ baseUrl: 'https://windmill.example.com', workspace: 'main', token: 'wm-test-token-not-a-secret-1234' }, { maxBytes: 0, maxFlows: 0, maxTotalBytes: 0 }, { fetchImpl });
    const out = await compareImported(
        { flows: conv.flows, results, limits: { runs: 5, flows: 20 }, saveAsTests, userId: ctx.userId },
        { fetchRuns: (p, n, moduleIds) => fetchFlowRuns(session, p, n, { moduleIds }) },
    );
    return { automationId: results[0].automationId, out, calls };
}

const runsOf = async (automationId) => (await pg.query('SELECT id, status, mode, trigger_payload FROM automation_runs WHERE automation_id = $1', [automationId])).rows;

test('each Windmill run becomes a dry run of the draft; the summary is stored and the dry runs are gone', async () => {
    const { automationId, out, calls } = await importAndCompare(false);
    assert.ok(calls.some((u) => u.includes(`script_path_exact=${encodeURIComponent(FLOW_PATH)}`)));
    const row = await automationStore.getImportForAutomation(automationId);
    const c = row.report.comparison;
    assert.strictEqual(c.status, 'done');
    assert.deepStrictEqual(out.get(FLOW_PATH).scenarios.length, 2);
    assert.deepStrictEqual(c.scenarios.map((s) => [s.windmillRunId, s.status, s.reachedEnd]), [[RUN_OK, 'success', true], [RUN_TWO, 'success', true]]);
    const [first] = c.scenarios;
    assert.strictEqual(first.shapeDiffs.length, 1, JSON.stringify(first.shapeDiffs));
    assert.deepStrictEqual(first.shapeDiffs[0].missing, ['currency', 'owner']);
    assert.deepStrictEqual(first.shapeDiffs[0].extra, []);
    assert.strictEqual(first.shapeDiffs[0].wmId, 'vat');
    assert.ok(first.shapeDiffs[0].stepId.startsWith('vat'), 'the stored (re-keyed) step id');
    assert.deepStrictEqual(first.failedSteps, []);
    assert.strictEqual(first.saved, null);

    assert.deepStrictEqual(await runsOf(automationId), [], 'no dry run of the comparison is kept');
    // A clean dry run of the stored version: the gate's own rule marks it.
    const a = await automationStore.getAutomation(automationId);
    assert.ok(row.dryRunOkAt, 'the dry-run mark is set');
    assert.strictEqual(row.dryRunVersion, a.version);

    const text = JSON.stringify(row.report);
    assert.ok(!text.includes(SECRET), 'no secret-looking value in the report');
    assert.ok(!text.includes(PERSON), 'no personal-looking value in the report');
    assert.ok(!text.includes('12.1'), 'no result value in the report');
});

test('"Save the runs as test cases": the runs that reached the end stay as golden runs, their input scrubbed', async () => {
    const { automationId } = await importAndCompare(true);
    const goldens = await testingStore.listGoldens(automationId);
    assert.strictEqual(goldens.length, 2);
    assert.deepStrictEqual(goldens.map((g) => g.label).sort(), ['Windmill run 018f6a2e', 'Windmill run 018f6a2e']);
    const runs = await runsOf(automationId);
    assert.deepStrictEqual(runs.map((r) => r.mode), ['dry_run', 'dry_run']);
    assert.deepStrictEqual(new Set(runs.map((r) => r.id)), new Set(goldens.map((g) => g.runId)));
    const kept = runs.map((r) => (typeof r.trigger_payload === 'string' ? r.trigger_payload : JSON.stringify(r.trigger_payload))).join('\n');
    assert.ok(!kept.includes(SECRET), 'the secret-shaped value was scrubbed before the run');
    const row = await automationStore.getImportForAutomation(automationId);
    assert.strictEqual(row.report.comparison.savedAsTests, true);
    assert.ok(row.report.comparison.scenarios.every((s) => s.saved?.golden === true));
    assert.ok(!JSON.stringify(row.report).includes(SECRET));
});

test('the clean-up deletes only a finished dry run of that automation, never a live run or another automation\'s', async () => {
    const { automationId } = await importAndCompare(false);
    const live = await automationStore.createRun({ automationId, version: 1, userId: ctx.userId, triggerKind: 'manual', mode: 'live' });
    await automationStore.updateRun(live.id, { status: 'success' });
    const dry = await automationStore.createRun({ automationId, version: 1, userId: ctx.userId, triggerKind: 'dry_run', mode: 'dry_run' });
    assert.strictEqual(await automationStore.deleteFinishedDryRun(automationId, dry.id), 0, 'a dry run still running stays');
    await automationStore.updateRun(dry.id, { status: 'success' });
    assert.strictEqual(await automationStore.deleteFinishedDryRun('another-automation', dry.id), 0);
    assert.strictEqual(await automationStore.deleteFinishedDryRun(automationId, live.id), 0, 'a live run stays');
    assert.strictEqual(await automationStore.deleteFinishedDryRun(automationId, dry.id), 1);
    assert.deepStrictEqual((await runsOf(automationId)).map((r) => r.id), [live.id]);
});
