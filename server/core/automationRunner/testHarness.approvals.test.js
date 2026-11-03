/**
 * A test harness carries approval decisions too (pauses F10, studio F7,
 * tests-and-docs F12): a scenario, a golden replay or "restart with my answers"
 * can approve or reject an approval step with the approver's answers.
 *
 *   approvals: { [stepId]: { decision: 'approve'|'reject', answers } }
 *
 *   - approve: the one approval output shape, answers coerced like a person's;
 *   - reject with an 'on_rejected' edge wired: approved:false, the run takes
 *     that branch (runDagRecord routes on it); without the edge it ends as a
 *     live rejection does (ApprovalRejected);
 *   - a step the harness has nothing for: synthesised, marked _scenarioMissing,
 *     and named in the run's warnings (scenario_missing), page or approval.
 *
 * Run: node --test core/automationRunner/testHarness.approvals.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');
process.env.NODE_ENV = 'test';

const { normalizeHarness, approvalDecisionFor } = require('./testHarness');
const { execApproval, execFormPage } = require('./execApproval');
const { setPauseDepsForTests } = require('./dryPause.mts');
const { approvalOutput } = require('../automationModel/approvalOutput.mts');

before(() => setPauseDepsForTests({ hasCapability: async () => true, validateAssignee: async (s) => s, groupMemberTotal: async () => 1 }));
after(() => setPauseDepsForTests(null));

const CONTRACT = Object.keys(approvalOutput()).sort();
const STEP = {
    id: 'ap', type: 'approval', title: 'Budget sign-off', prompt: 'OK?',
    approval: { fields: [{ name: 'budget', label: 'Budget', type: 'number', required: true }] },
};
const harnessOf = (approvals, pages = null) => normalizeHarness({ source: { kind: 'scenario', id: 'fsc_1' }, approvals, formAnswers: pages ? { pages } : null });
const ctxOf = (harness, edges = []) => ({ layerStack: [], testHarness: harness, definition: { edges }, profile: { kind: 'dry', pauses: 'harness' } });
const state = () => ({ trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, _templateWarnings: [] });

test('normalizeHarness keeps known decisions, answers as a frozen copy, and drops the rest', () => {
    const answers = { budget: 12 };
    const h = normalizeHarness({ approvals: { ap: { decision: 'approve', answers }, x: { decision: 'maybe' }, y: 'reject', z: { decision: 'reject' } } });
    assert.deepStrictEqual({ ...h.approvals }, { ap: { decision: 'approve', answers: { budget: 12 } }, z: { decision: 'reject', answers: {} } });
    assert.ok(Object.isFrozen(h.approvals.ap.answers));
    assert.ok(!Object.isFrozen(answers), "the caller's object is not frozen");
    assert.strictEqual(normalizeHarness({}).approvals, null);
    assert.strictEqual(normalizeHarness({ source: { kind: 'run', id: 'r1' } }).source.kind, 'run');
});

test('approvalDecisionFor answers per step, null when the harness has none', () => {
    const ctx = ctxOf(harnessOf({ ap: { decision: 'reject', answers: {} } }));
    assert.deepStrictEqual({ ...approvalDecisionFor(ctx, 'ap') }, { decision: 'reject', answers: {} });
    assert.strictEqual(approvalDecisionFor(ctx, 'other'), null);
    assert.strictEqual(approvalDecisionFor({}, 'ap'), null);
});

test('approve: the contract keys, answers coerced like a decision, marked as from the scenario', async () => {
    const res = await execApproval(STEP, ctxOf(harnessOf({ ap: { decision: 'approve', answers: { budget: '1200' } } })), state(), 'dry_run');
    assert.deepStrictEqual(Object.keys(res.output).filter((k) => !k.startsWith('_')).sort(), CONTRACT);
    assert.strictEqual(res.output.approved, true);
    assert.deepStrictEqual(res.output.answers, { budget: 1200 });
    assert.strictEqual(res.output._fromScenario, true);
    assert.strictEqual(res.output._dryRun, true);
    assert.strictEqual(res.dryRunSynthesised, undefined, 'a saved decision is not synthesised data');
});

test('scenario reject with an on_rejected edge: approved false, the run takes the rejected branch', async () => {
    const edges = [{ from: 'ap', to: 'yes' }, { from: 'ap', to: 'no', label: 'on_rejected' }];
    const res = await execApproval(STEP, ctxOf(harnessOf({ ap: { decision: 'reject', answers: {} } }), edges), state(), 'dry_run');
    assert.strictEqual(res.output.approved, false);
    assert.deepStrictEqual(Object.keys(res.output).filter((k) => !k.startsWith('_')).sort(), CONTRACT);
});

test('scenario reject without the edge ends the run as a live rejection does', async () => {
    await assert.rejects(
        execApproval(STEP, ctxOf(harnessOf({ ap: { decision: 'reject', answers: {} } }), [{ from: 'ap', to: 'yes' }]), state(), 'dry_run'),
        (e) => e.errorClass === 'ApprovalRejected',
    );
});

test('approve with answers that no longer fit fails by label, never by value', async () => {
    await assert.rejects(
        execApproval(STEP, ctxOf(harnessOf({ ap: { decision: 'approve', answers: { budget: 'SYNTHETIC-NOT-A-NUMBER' } } })), state(), 'dry_run'),
        (e) => e.errorClass === 'scenario_answers_invalid' && e.message.includes('Budget') && !e.message.includes('SYNTHETIC'),
    );
});

test('no decision in the harness: auto-approved, _scenarioMissing, and a scenario_missing warning', async () => {
    const rs = state();
    const res = await execApproval(STEP, ctxOf(harnessOf({ other: { decision: 'approve' } })), rs, 'dry_run');
    assert.strictEqual(res.output.approved, true);
    assert.strictEqual(res.output._scenarioMissing, true);
    assert.strictEqual(res.dryRunSynthesised, true);
    assert.match(rs._templateWarnings.join('\n'), /Approval "Budget sign-off" has no decision in the saved answers \(scenario_missing\)/);
});

test('a form page the scenario has no answers for: blanks, _scenarioMissing, and a warning (pauses F12)', async () => {
    const rs = state();
    const page = { id: 'fp2', type: 'form_page', mode: 'input', title: 'Page two', form: { title: 'P', fields: [{ name: 'city', type: 'text', label: 'City' }] } };
    const res = await execFormPage(page, ctxOf(harnessOf(null, { fp1: { a: 1 } })), rs, 'dry_run');
    assert.deepStrictEqual(res.output, { city: '', _dryRun: true, _scenarioMissing: true });
    assert.strictEqual(res.dryRunFallback, 'form_blank');
    assert.match(rs._templateWarnings.join('\n'), /Form page "Page two" has no saved answers \(scenario_missing\)/);
});
