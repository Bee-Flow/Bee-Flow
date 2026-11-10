/**
 * RM-12: a test run never touches the automation's running marker or its last
 * status. Run live (test), ▶ Execute and a dry run carry a profile that does
 * not hold the marker (runProfile.mts holdsMarker), so they never acquire it,
 * never wait for it, are never skipped as "already running", never release it
 * and never write lastStatus / lastRunAt. A production run still does all of it.
 * Every lifecycle event carries startedByUserId.
 *
 * Stores replaced through automationRunner.testkit. No DB / external services.
 * Run: cd server && node --test core/automationRunner/runHeartbeat.testMarker.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeMemoryRunStore } = require('../../testUtils/memoryRunStore');
const { installRunnerStoreStubs } = require('../automationRunner.testkit');

// The kit puts its store in place of stores/automationStore; this suite fills
// it with the in-memory run store and records every marker call.
const { storeStub } = installRunnerStoreStubs();
const memory = makeMemoryRunStore();
/** Every call that touches the automations row's marker or last status. */
const markerCalls = [];
let busy = false;   // markRunning's answer: true = another live run holds the marker
Object.assign(storeStub, memory.methods, {
    // The real store keeps the profile, the test flag and the starter on the row.
    createRun: async (args) => Object.assign(await memory.methods.createRun(args), {
        isTest: !!args.isTest, startedByUserId: args.startedByUserId ?? null, profile: args.runProfile ?? null,
    }),
    markRunning: async (id) => { markerCalls.push(['markRunning', id]); return !busy; },
    releaseAutomation: async (id) => { markerCalls.push(['releaseAutomation', id]); },
    updateAutomation: async (id, patch) => { markerCalls.push(['updateAutomation', id, Object.keys(patch).sort().join(',')]); return true; },
    touchAutomationRunning: async (id) => { markerCalls.push(['touchAutomationRunning', id]); },
});

// A busy marker must not make a webhook wait in these tests.
process.env.AUTOMATION_CONCURRENT_WAIT_MS = '0';
const runner = require('../automationRunner');
const runEventBus = require('../runEventBus');

const events = [];
const offEvents = runEventBus.onAny((e) => events.push(e));
after(() => { offEvents(); setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(() => { memory.reset(); markerCalls.length = 0; events.length = 0; busy = false; });

function automation() {
    return {
        id: 'auto-m', version: 1, userId: 'owner-1', organizationId: null, title: 'Marker', triggerType: 'webhook',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'webhook' },
            steps: [{ id: 's1', type: 'set', fields: { ok: { kind: 'literal', value: true } } }],
            edges: [{ from: 'trig', to: 's1' }],
        },
    };
}

test('Run live (test) never acquires, releases or writes the last status', async () => {
    const run = await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live', isTest: true, startedByUserId: 'tester-1' });
    assert.strictEqual(run.status, 'success');
    assert.deepStrictEqual(markerCalls, []);
    assert.strictEqual(memory.runs.get(run.id).profile.holdsMarker, false);
});

test('a test run is not skipped while a live run holds the marker', async () => {
    busy = true;
    const run = await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live', isTest: true, startedByUserId: 'tester-1' });
    assert.strictEqual(run.status, 'success', 'it runs alongside, it is not "already running"');
    assert.deepStrictEqual(markerCalls, []);
});

test('▶ Execute (manual_step) and a dry run leave the marker alone too', async () => {
    const step = await runner.runPartial(automation(), 's1', { mode: 'only', triggerKind: 'manual_step', startedByUserId: 'tester-1' });
    assert.strictEqual(step.status, 'success');
    const dry = await runner.executeAutomation(automation(), { triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: 'tester-1' });
    assert.strictEqual(dry.status, 'success');
    assert.deepStrictEqual(markerCalls, []);
});

test('a production run still claims, releases and records the last status', async () => {
    const run = await runner.executeAutomation(automation(), { triggerKind: 'webhook', mode: 'live', triggerPayload: { a: 1 } });
    assert.strictEqual(run.status, 'success');
    const kinds = markerCalls.map((c) => c[0]);
    assert.ok(kinds.includes('markRunning'));
    assert.ok(kinds.includes('releaseAutomation'));
    assert.ok(markerCalls.some((c) => c[0] === 'updateAutomation' && c[2] === 'lastRunAt,lastStatus'));
});

test('a production run is still skipped while the marker is held', async () => {
    busy = true;
    const run = await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live' });
    assert.strictEqual(run.status, 'cancelled');
});

test('lifecycle events carry who started the run', async () => {
    await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live', isTest: true, startedByUserId: 'tester-1' });
    const mine = events.filter((e) => e.automationId === 'auto-m');
    assert.ok(mine.some((e) => e.type === 'run.started'));
    assert.ok(mine.every((e) => e.startedByUserId === 'tester-1'), JSON.stringify(mine.map((e) => [e.type, e.startedByUserId])));
    events.length = 0;
    await runner.executeAutomation(automation(), { triggerKind: 'webhook', mode: 'live', triggerPayload: { a: 1 } });
    assert.ok(events.filter((e) => e.automationId === 'auto-m').every((e) => e.startedByUserId === null));
});

// ═══ Only the SCHEDULER's own claim lets a run skip the marker acquisition ═══
//
// "triggerKind === 'schedule'" does not mean "the tick already claimed this
// row for me". Two other callers start a run with that kind and no claim: a
// retry of a scheduled run (POST /:id/runs/:runId/retry passes the original
// run's triggerKind) and the resume of a scheduled run after an approval or
// form pause (resume.js does the same). Handed ownership of the marker without
// asking, both run alongside whatever live run holds it, and at their end
// write the automation's last status and RELEASE that other run's marker —
// after which the scheduler can start yet another run on top of it.
//
// The tick now says so explicitly (`markerClaimed: true`); every other
// schedule-kind run asks for the marker like any other live run.
//

function scheduledAutomation() {
    return {
        id: 'auto-s', version: 1, userId: 'owner-1', organizationId: null, title: 'Nightly', triggerType: 'schedule',
        scheduleCron: '0 7 * * *', scheduleTz: 'UTC',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'schedule' },
            steps: [{ id: 's1', type: 'set', fields: { ok: { kind: 'literal', value: true } } }],
            edges: [{ from: 'trig', to: 's1' }],
        },
    };
}
const scheduleKinds = () => markerCalls.map((c) => c[0]);
const scheduleWroteLastStatus = () => markerCalls.some((c) => c[0] === 'updateAutomation' && c[2].includes('lastStatus'));

test('a run the scheduler claimed does not ask for the marker again, and releases it', async () => {
    const run = await runner.executeAutomation(scheduledAutomation(), { triggerKind: 'schedule', mode: 'live', markerClaimed: true });
    assert.strictEqual(run.status, 'success');
    assert.ok(!scheduleKinds().includes('markRunning'), 'the tick claimed the row: asking again would answer "already running"');
    assert.ok(scheduleKinds().includes('releaseAutomation'));
});

test('a retry of a scheduled run does not take over a marker another run holds', async () => {
    busy = true;
    const run = await runner.executeAutomation(scheduledAutomation(), { triggerKind: 'schedule', mode: 'live' });
    assert.ok(scheduleKinds().includes('markRunning'), 'a schedule-kind run nobody claimed for must ask for the marker');
    assert.strictEqual(run.status, 'cancelled', 'like any live run that finds the automation busy');
    assert.ok(!scheduleKinds().includes('releaseAutomation'), 'it released the marker of the run that is still going');
    assert.ok(!scheduleWroteLastStatus(), 'it overwrote the last status of the run that is still going');
});

test('a retry of a scheduled run on a free automation owns and releases the marker', async () => {
    const run = await runner.executeAutomation(scheduledAutomation(), { triggerKind: 'schedule', mode: 'live' });
    assert.strictEqual(run.status, 'success');
    assert.ok(scheduleKinds().includes('markRunning') && scheduleKinds().includes('releaseAutomation'));
});

test('a resumed scheduled run continues alongside a busy automation without owning its marker', async () => {
    busy = true;
    const run = await runner.executeAutomation(scheduledAutomation(), {
        triggerKind: 'schedule', mode: 'live', skipUntilStepId: 'trig', replayState: { trig: { output: {}, status: 'success' } },
    });
    assert.strictEqual(run.status, 'success', 'a resume is a continuation, never skipped');
    assert.ok(!scheduleKinds().includes('releaseAutomation'), 'the resume released the marker of the run that is still going');
    assert.ok(!scheduleWroteLastStatus());
});
