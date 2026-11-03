/**
 * The web builder's Dry run pauses for real (D1): executeAutomation with
 * `pausesRequested` in mode dry_run throws the live sentinels at an approval
 * and a form page, so the run waits in awaiting_approval / awaiting_form for
 * the author (the sandbox seat: the tester decides). The answer resumes it as a
 * dry run, so a write after the pause stays simulated.
 *
 * A test or dry pause waits at most AUTOMATION_TEST_PAUSE_TTL_MS, so the
 * reaper (which reads awaiting_step_expires_at in every mode) ends a pause the
 * author walked away from.
 *
 * Stores replaced through automationRunner.testkit; licence and seat lookups
 * through dryPause.mts's seam. No DB / external services.
 * Run: cd server && node --test core/automationRunner/execApproval.dryPause.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeMemoryRunStore } = require('../../testUtils/memoryRunStore');
const { installRunnerStoreStubs } = require('../automationRunner.testkit');

const TTL_MS = 10 * 60_000;
process.env.AUTOMATION_TEST_PAUSE_TTL_MS = String(TTL_MS);

const { storeStub } = installRunnerStoreStubs();
const memory = makeMemoryRunStore();
const { runs, stepsByRun } = memory;
Object.assign(storeStub, memory.methods, {
    createRun: async (args) => Object.assign(await memory.methods.createRun(args), {
        isTest: !!args.isTest, startedByUserId: args.startedByUserId ?? null, profile: args.runProfile ?? null,
    }),
});

const { setPauseDepsForTests } = require('./dryPause.mts');
setPauseDepsForTests({ hasCapability: async () => true, validateAssignee: async (seat) => seat, groupMemberTotal: async () => 1 });
const runner = require('../automationRunner');

after(() => { setPauseDepsForTests(null); setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(memory.reset);

const rowsOf = (runId) => stepsByRun.get(runId) || [];
const rowOf = (runId, stepId) => rowsOf(runId).find((s) => s.stepId === stepId);

/** trigger → ap (approval, 3-day deadline) → send (notification: a write) */
function approvalFlow() {
    return {
        id: 'auto-dp', version: 1, userId: 'owner-1', organizationId: null, title: 'Dry pause', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'ap', type: 'approval', prompt: 'Send it?', expiresInHours: 72, approval: { fields: [{ name: 'note', label: 'Note', type: 'text' }] } },
                { id: 'send', type: 'notification', channels: ['notification'], title: 'Approved', body: 'Note: {{steps.ap.output.answers.note}}' },
            ],
            edges: [{ from: 'trig', to: 'ap' }, { from: 'ap', to: 'send' }],
        },
    };
}

/** trigger → fp (form page, 1 hour) → after */
function formFlow() {
    return {
        id: 'auto-df', version: 1, userId: 'owner-1', organizationId: null, title: 'Dry form', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'fp', type: 'form_page', mode: 'input', waitSeconds: 3600, form: { title: 'Page', fields: [{ name: 'answer', type: 'text' }] } },
                { id: 'after', type: 'set', fields: { got: { kind: 'ref', path: 'steps.fp.output.answer' } } },
            ],
            edges: [{ from: 'trig', to: 'fp' }, { from: 'fp', to: 'after' }],
        },
    };
}

test('pauses real in a dry run: the run waits on the approval, the tester holds the seat', async () => {
    memory.automation = approvalFlow();
    const started = Date.now();
    const paused = await runner.executeAutomation(memory.automation, {
        triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: 'tester-1', pausesRequested: true, origin: 'builder',
    });
    assert.strictEqual(paused.status, 'awaiting_approval');
    assert.strictEqual(paused.mode, 'dry_run');
    const profile = runs.get(paused.id).profile;
    assert.strictEqual(profile.kind, 'dry');
    assert.strictEqual(profile.pauses, 'real');
    assert.strictEqual(profile.origin, 'builder');
    assert.deepStrictEqual(profile.approverSeat, { kind: 'tester', userId: 'tester-1' });

    const row = rowOf(paused.id, 'ap');
    assert.strictEqual(row.status, 'awaiting_approval');
    assert.strictEqual(row.output.prompt, 'Send it?', 'the prompt stays on the paused step row');
    assert.strictEqual(row.output._preview.route, 'owner', 'the routing preview rides on the paused row');
    assert.ok(!rowOf(paused.id, 'send'), 'nothing after the pause ran');

    // The 72-hour step deadline is cut to the test pause TTL.
    const expires = Date.parse(runs.get(paused.id).awaitingStepExpiresAt);
    assert.ok(expires >= started + TTL_MS - 1000 && expires <= Date.now() + TTL_MS + 1000, `expires at the test TTL, got ${runs.get(paused.id).awaitingStepExpiresAt}`);
});

test('the answer resumes it as a dry run: the write after the approval is simulated', async () => {
    memory.automation = approvalFlow();
    const paused = await runner.executeAutomation(memory.automation, {
        triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: 'tester-1', pausesRequested: true, origin: 'builder',
    });
    const decision = { approved: true, by: 'tester-1', reason: null, decidedAt: new Date().toISOString(), answers: { note: 'fine' }, votes: [] };
    const resumed = await runner.resumeFromStep(paused.id, 'ap', { decision, userId: 'tester-1' });
    assert.strictEqual(resumed.mode, 'dry_run', 'a resume never changes kind');
    assert.strictEqual(resumed.status, 'success');
    assert.strictEqual(runs.get(resumed.id).profile.kind, 'dry');
    const send = rowOf(resumed.id, 'send');
    assert.ok(send, 'the step after the approval ran');
    assert.strictEqual(send.output._dryRun, true, 'and it was simulated, not sent');
    assert.match(JSON.stringify(send.output), /Note: fine/, 'with the answer the author gave');
});

test('a form page pauses for real too, at the earlier of its own wait and the test TTL', async () => {
    memory.automation = formFlow();
    const started = Date.now();
    const paused = await runner.executeAutomation(memory.automation, {
        triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: 'tester-1', pausesRequested: true,
    });
    assert.strictEqual(paused.status, 'awaiting_form');
    assert.strictEqual(rowOf(paused.id, 'fp').status, 'awaiting_form');
    const expires = Date.parse(runs.get(paused.id).awaitingStepExpiresAt);
    assert.ok(expires <= started + TTL_MS + 1000 && expires > started, 'the 1-hour page waits the 10-minute test TTL');

    const resumed = await runner.resumeFromStep(paused.id, 'fp', { decision: { answer: 'Main Street 1' }, userId: 'tester-1' });
    assert.strictEqual(resumed.mode, 'dry_run');
    assert.deepStrictEqual(rowOf(resumed.id, 'after').output, { got: 'Main Street 1' });
});

test('without the request the same dry run asks nobody: approved, marked, never paused', async () => {
    memory.automation = approvalFlow();
    const run = await runner.executeAutomation(memory.automation, { triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: 'tester-1' });
    assert.strictEqual(run.status, 'success');
    assert.strictEqual(runs.get(run.id).profile.pauses, 'synthesise');
    const ap = rowOf(run.id, 'ap');
    assert.strictEqual(ap.output._dryRunSynthesised, true);
    assert.strictEqual(ap.output._dryRunFallback, 'auto_approved');
    assert.strictEqual(ap.output.by, 'dry_run');
});

test('a live production pause keeps the step deadline: the test TTL is for test and dry runs only', async () => {
    memory.automation = approvalFlow();
    const started = Date.now();
    const paused = await runner.executeAutomation(memory.automation, { triggerKind: 'manual', mode: 'live' });
    assert.strictEqual(paused.status, 'awaiting_approval');
    const expires = Date.parse(runs.get(paused.id).awaitingStepExpiresAt);
    assert.ok(expires > started + 71 * 3600_000 && expires < started + 73 * 3600_000, 'the 72-hour deadline stands');
    assert.strictEqual(rowOf(paused.id, 'ap').output._preview, undefined, 'no preview outside a dry run');
});
