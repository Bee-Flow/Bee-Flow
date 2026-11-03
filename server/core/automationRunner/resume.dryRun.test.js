/**
 * A dry run that paused for real (the web builder answered its approval or form
 * page) resumes as a DRY run: the run profile says kind 'dry', so the
 * continuation keeps mode 'dry_run' and every write after the answer stays
 * simulated. Before the profile the resume hard-coded mode 'live'.
 *
 * Stores replaced through automationRunner.testkit. No DB / external services: the
 * write step is an HTTP POST, which a dry run synthesises before any request.
 * Run: cd server && node --test core/automationRunner/resume.dryRun.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeMemoryRunStore } = require('../../testUtils/memoryRunStore');
const { installRunnerStoreStubs } = require('../automationRunner.testkit');

// The kit puts its store in place of stores/automationStore; this suite fills
// it with the in-memory run store, which keeps step rows for the resume.
const { storeStub } = installRunnerStoreStubs();
const memory = makeMemoryRunStore();
const { runs, stepsByRun } = memory;
const markerCalls = [];
Object.assign(storeStub, memory.methods, {
    // The real store keeps the profile, the test flag and the starter on the row.
    createRun: async (args) => Object.assign(await memory.methods.createRun(args), {
        isTest: !!args.isTest, startedByUserId: args.startedByUserId ?? null, profile: args.runProfile ?? null,
    }),
    markRunning: async (...a) => { markerCalls.push(['markRunning', ...a]); return true; },
    releaseAutomation: async (...a) => { markerCalls.push(['releaseAutomation', ...a]); },
});

const runner = require('../automationRunner');
const { profileFor } = require('../automationModel/runProfile.mts');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(() => { memory.reset(); markerCalls.length = 0; });

/** trigger → appr (approval) → post (HTTP POST, a write) → tail (binds the post). */
function flow() {
    return {
        id: 'auto-dry', version: 1, userId: 'owner-1', organizationId: null, title: 'Dry resume', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'appr', type: 'approval', prompt: 'Send it?' },
                { id: 'post', type: 'http_request', method: 'POST', url: 'https://hooks.example.invalid/orders', body: '{"ok":true}' },
                { id: 'tail', type: 'set', fields: { status: { kind: 'ref', path: 'steps.post.output.status' } } },
            ],
            edges: [{ from: 'trig', to: 'appr' }, { from: 'appr', to: 'post' }, { from: 'post', to: 'tail' }],
        },
    };
}

/** A dry run of flow() paused on `appr`, as the builder's real pause leaves it. */
async function pausedDryRun() {
    memory.automation = flow();
    const profile = profileFor({ mode: 'dry_run', triggerKind: 'dry_run', startedByUserId: 'tester-1', pausesRequested: true }, {});
    const row = await storeStub.createRun({
        automationId: 'auto-dry', version: 1, userId: 'owner-1', triggerKind: 'dry_run', triggerPayload: null,
        mode: 'dry_run', isTest: true, startedByUserId: 'tester-1', runProfile: profile,
    });
    Object.assign(row, { status: 'awaiting_approval', awaitingStepId: 'appr' });
    await storeStub.recordRunStep({ runId: row.id, stepId: 'appr', stepType: 'approval', attempts: 1, status: 'awaiting_approval', output: null });
    return row;
}

test('the resumed leg stays mode dry_run with the same profile, and its write is synthesised', async () => {
    const paused = await pausedDryRun();
    const resumed = await runner.resumeFromStep(paused.id, 'appr', { userId: 'tester-1' });

    assert.strictEqual(resumed.status, 'success');
    assert.strictEqual(resumed.mode, 'dry_run', 'a resume never turns a dry run live');
    const row = runs.get(resumed.id);
    assert.strictEqual(row.profile.kind, 'dry');
    assert.strictEqual(row.profile.effects, 'simulated');
    assert.strictEqual(row.profile.pauses, 'real');
    assert.deepStrictEqual(row.profile.approverSeat, { kind: 'tester', userId: 'tester-1' });
    assert.strictEqual(row.isTest, true);
    assert.strictEqual(row.parentRunId, paused.id);
    assert.strictEqual(row.rootRunId, paused.id, 'one journey');

    const out = (id) => (stepsByRun.get(resumed.id) || []).find((s) => s.stepId === id)?.output;
    assert.strictEqual(out('post')._dryRun, true, 'the POST after the answer was simulated, not sent');
    assert.deepStrictEqual(out('tail'), { status: 200 });
    // The answer is recorded on the dry leg too, so a second pause keeps it.
    assert.strictEqual(out('appr').approved, true);
    // A dry run never touches the running marker.
    assert.deepStrictEqual(markerCalls, []);
});

test('the decision the caller passes lands as the boundary output of the dry leg', async () => {
    const paused = await pausedDryRun();
    const decision = { approved: true, by: 'tester-1', reason: 'fine', decidedAt: '2026-11-03T10:00:00.000Z', answers: { a: 1 }, votes: [] };
    const resumed = await runner.resumeFromStep(paused.id, 'appr', { decision, userId: 'tester-1' });
    assert.strictEqual(resumed.mode, 'dry_run');
    const appr = (stepsByRun.get(resumed.id) || []).find((s) => s.stepId === 'appr');
    assert.deepStrictEqual(appr.output, decision);
});
