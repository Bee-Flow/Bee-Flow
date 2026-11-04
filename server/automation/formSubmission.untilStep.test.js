/**
 * A builder form test bounded to one step (formSubmission.mts stoppingAfter,
 * POST /:id/form-test untilStepId): "Test step" on a step after a form nobody
 * has filled in yet starts the form's own dry run and ends after that step.
 * Driven through the queue's real submit call (formQueueWork.submitThunk) and
 * the REAL runner on the in-memory run store, so "ends after" is the rows the
 * run wrote: the step after the bound has none, and a pause on the way keeps
 * the bound for the resume (the run profile's stopAfterStepId).
 *
 * Stores replaced through automationRunner.testkit. No DB / external services.
 * Run: cd server && node --test automation/formSubmission.untilStep.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeMemoryRunStore } = require('../testUtils/memoryRunStore');
const { installRunnerStoreStubs } = require('../core/automationRunner.testkit');

const { storeStub } = installRunnerStoreStubs();
const memory = makeMemoryRunStore();
const { runs, stepsByRun } = memory;
Object.assign(storeStub, memory.methods, {
    createRun: async (args) => Object.assign(await memory.methods.createRun(args), {
        isTest: !!args.isTest, startedByUserId: args.startedByUserId ?? null, profile: args.runProfile ?? null,
    }),
    attachFormSessionRun: async () => {},
});

const runner = require('../core/automationRunner');
const { createFormWork } = require('./formQueueWork');
const { startSubmission, stoppingAfter } = require('./formSubmission.mts');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(memory.reset);

const formWork = createFormWork({ automationStore: storeStub, runner: () => runner, formAnswers: () => ({}) });
const stepIdsOf = (runId) => (stepsByRun.get(runId) || []).map((s) => s.stepId);
const set = (id, fields = { done: { kind: 'literal', value: true } }) => ({ id, type: 'set', fields });
const FORM = { title: 'Get in touch', fields: [{ name: 'name', type: 'text', label: 'Name' }, { name: 'email', type: 'email', label: 'Email' }] };

/** form trigger → s1 (binds an answer) → s2 → s3, or with a form page `fp` between s1 and s2. */
function automation(withPage = false) {
    const steps = [set('s1', { who: { kind: 'ref', path: 'trigger.output.name' } }), set('s2'), set('s3')];
    const edges = [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }, { from: 's2', to: 's3' }];
    if (withPage) {
        steps.splice(1, 0, { id: 'fp', type: 'form_page', mode: 'input', form: { title: 'More', fields: [{ name: 'extra', type: 'text' }] } });
        edges.splice(1, 1, { from: 's1', to: 'fp' }, { from: 'fp', to: 's2' });
    }
    return {
        id: 'auto-ft', version: 1, userId: 'owner-1', organizationId: null, title: 'Bounded form test', triggerType: 'form',
        definition: { trigger: { id: 'trg', type: 'trigger', kind: 'form', form: FORM }, steps, edges },
    };
}

/** What acceptSubmission hands back for the builder's dry form test (BUILDER_DRY_SUBMISSION). */
const accepted = () => ({
    session: { id: 'sess1', rootStepId: null, triggerHeaders: { test: true } },
    work: { kind: 'submit', payload: { name: 'Ada', email: 'ada@example.com' }, submitterId: 'tester-1', publicForm: false, isTest: true, origin: 'builder', mode: 'dry_run' },
});

const found = () => ({ token: 'page1', page: { triggerStepId: null }, automation: memory.automation, definition: { trigger: memory.automation.definition.trigger } });

test('a dry form test bounded to s2 ends after s2: s3 has no row, and the run entered with the answers', async () => {
    memory.automation = automation();
    const run = await startSubmission(found(), stoppingAfter(accepted(), 's2'), null, formWork);
    assert.strictEqual(run.status, 'success', JSON.stringify(run));
    const ids = stepIdsOf(run.id);
    assert.ok(ids.includes('s1') && ids.includes('s2'), `the steps up to the bound ran, got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes('s3'), 'nothing after the bound ran');
    const row = runs.get(run.id);
    assert.strictEqual(row.mode, 'dry_run');
    assert.strictEqual(row.profile.kind, 'dry');
    assert.strictEqual(row.profile.stopAfterStepId, 's2');
    assert.deepStrictEqual(row.triggerPayload, { name: 'Ada', email: 'ada@example.com' });
    const s1 = (stepsByRun.get(run.id) || []).find((s) => s.stepId === 's1');
    assert.deepStrictEqual(s1.output, { who: 'Ada' }, 'the step read the submitted answer');
});

test('unbounded, the same form test runs the whole flow', async () => {
    memory.automation = automation();
    const run = await startSubmission(found(), stoppingAfter(accepted(), null), null, formWork);
    assert.ok(stepIdsOf(run.id).includes('s3'));
    assert.strictEqual(runs.get(run.id).profile.stopAfterStepId, null);
});

test('a form page before the bound pauses for real, and the resume still ends after the bound', async () => {
    memory.automation = automation(true);
    const paused = await startSubmission(found(), stoppingAfter(accepted(), 's2'), null, formWork);
    assert.strictEqual(paused.status, 'awaiting_form', JSON.stringify(paused));
    assert.strictEqual(runs.get(paused.id).profile.stopAfterStepId, 's2');

    const resumed = await runner.resumeFromStep(paused.id, 'fp', { decision: { extra: 'more' }, userId: 'tester-1' });
    assert.strictEqual(resumed.status, 'success');
    assert.strictEqual(resumed.mode, 'dry_run', 'still a dry run');
    const ids = stepIdsOf(resumed.id);
    assert.ok(ids.includes('s2'), `the bound ran after the answer, got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes('s3'), 'nothing after the bound ran');
});
