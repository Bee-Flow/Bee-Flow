/**
 * Only the SCHEDULER's own claim lets a run skip the marker acquisition.
 *
 * claimRunMarker used to read "triggerKind === 'schedule'" as "the tick
 * already claimed this row for me" and handed the run ownership of the marker
 * without asking. But two other callers start a run with that kind and no
 * claim: a retry of a scheduled run (POST /:id/runs/:runId/retry passes the
 * original run's triggerKind) and the resume of a scheduled run after an
 * approval or form pause (resume.js does the same). Both then ran alongside
 * whatever live run held the marker, and at their end wrote the automation's
 * last status and RELEASED that other run's marker — after which the scheduler
 * could start yet another run on top of it.
 *
 * The tick now says so explicitly (`markerClaimed: true`); every other
 * schedule-kind run asks for the marker like any other live run.
 *
 * Run: cd server && node --test core/automationRunner/runHeartbeat.scheduleKind.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeMemoryRunStore } = require('../../testUtils/memoryRunStore');
const { installRunnerStoreStubs } = require('../automationRunner.testkit');

const { storeStub } = installRunnerStoreStubs();
const memory = makeMemoryRunStore();
const markerCalls = [];
let busy = false;   // true = another live run holds the marker
Object.assign(storeStub, memory.methods, {
    markRunning: async (id) => { markerCalls.push(['markRunning', id]); return !busy; },
    releaseAutomation: async (id) => { markerCalls.push(['releaseAutomation', id]); },
    updateAutomation: async (id, patch) => { markerCalls.push(['updateAutomation', id, Object.keys(patch).sort().join(',')]); return true; },
    touchAutomationRunning: async (id) => { markerCalls.push(['touchAutomationRunning', id]); return true; },
});

process.env.AUTOMATION_CONCURRENT_WAIT_MS = '0';
const runner = require('../automationRunner');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(() => { memory.reset(); markerCalls.length = 0; busy = false; });

function automation() {
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
const kinds = () => markerCalls.map((c) => c[0]);
const wroteLastStatus = () => markerCalls.some((c) => c[0] === 'updateAutomation' && c[2].includes('lastStatus'));

test('a run the scheduler claimed does not ask for the marker again, and releases it', async () => {
    const run = await runner.executeAutomation(automation(), { triggerKind: 'schedule', mode: 'live', markerClaimed: true });
    assert.strictEqual(run.status, 'success');
    assert.ok(!kinds().includes('markRunning'), 'the tick claimed the row: asking again would answer "already running"');
    assert.ok(kinds().includes('releaseAutomation'));
});

test('a retry of a scheduled run does not take over a marker another run holds', async () => {
    busy = true;
    const run = await runner.executeAutomation(automation(), { triggerKind: 'schedule', mode: 'live' });
    assert.ok(kinds().includes('markRunning'), 'a schedule-kind run nobody claimed for must ask for the marker');
    assert.strictEqual(run.status, 'cancelled', 'like any live run that finds the automation busy');
    assert.ok(!kinds().includes('releaseAutomation'), 'it released the marker of the run that is still going');
    assert.ok(!wroteLastStatus(), 'it overwrote the last status of the run that is still going');
});

test('a retry of a scheduled run on a free automation owns and releases the marker', async () => {
    const run = await runner.executeAutomation(automation(), { triggerKind: 'schedule', mode: 'live' });
    assert.strictEqual(run.status, 'success');
    assert.ok(kinds().includes('markRunning') && kinds().includes('releaseAutomation'));
});

test('a resumed scheduled run continues alongside a busy automation without owning its marker', async () => {
    busy = true;
    const run = await runner.executeAutomation(automation(), {
        triggerKind: 'schedule', mode: 'live', skipUntilStepId: 'trig', replayState: { trig: { output: {}, status: 'success' } },
    });
    assert.strictEqual(run.status, 'success', 'a resume is a continuation, never skipped');
    assert.ok(!kinds().includes('releaseAutomation'), 'the resume released the marker of the run that is still going');
    assert.ok(!wroteLastStatus());
});
