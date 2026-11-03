/**
 * One shape for an approval step's output, whoever produced the decision
 * (critic gap 10): a person deciding live (approve and reject-with-branch),
 * a dry run's synthesis, a test harness's saved answer, and the shape the AI
 * builder checks bindings against. A binding that works in a dry run works
 * live, and the other way round.
 *
 * Producer markers are underscore-prefixed step-level stamps (`_dryRun`,
 * `_preview`, …) that bindings never read, so they are set aside; every other
 * key must be exactly the contract's.
 *
 * Run: node --test core/automationModel/approvalOutput.parity.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// The real modules over a recording pool, so nothing opens a connection.
require('../../testUtils/routeHarness').recordDb();
// The runner reaches automation/ (form answers) through its feature ports.
require('../../automation/runnerPorts');

const { approvalOutput } = require('./approvalOutput.mts');

const CONTRACT = Object.keys(approvalOutput()).sort();
const dataKeys = (out) => Object.keys(out || {}).filter(k => !k.startsWith('_')).sort();

const STEP = {
    id: 'ap', type: 'approval', prompt: 'Ship it?',
    approval: { fields: [{ name: 'note', label: 'Note', type: 'text' }] },
};

test('the contract is the six documented keys', () => {
    assert.deepStrictEqual(CONTRACT, ['answers', 'approved', 'by', 'decidedAt', 'reason', 'votes'].sort());
});

test('live decisions (approve, reject on a wired branch, a panel) hand the continuation the contract keys', async () => {
    const automationStore = require('../../stores/automationStore');
    const runner = require('../automationRunner');
    const resumeMod = require('../automationRunner/resume');
    const events = require('../../automation/approvalEvents');
    const hooks = require('../../automation/approvalHooks');
    const { finalizeDecision } = require('../../automation/approvalDecision');

    const approval = { id: 'apr-1', source: 'run', status: 'pending', ownerId: 'u1', runId: 'run-1', stepId: 'ap', prompt: 'Ship it?' };
    const run = { id: 'run-1', automationId: 'auto-1', version: 1, status: 'awaiting_approval' };
    const decisions = [];
    const saved = {
        decideApproval: automationStore.decideApproval, appendApprovalAudit: automationStore.appendApprovalAudit,
        updateRun: automationStore.updateRun, closeAwaitingStepRow: automationStore.closeAwaitingStepRow,
        resumeFromStep: runner.resumeFromStep, automationToResume: resumeMod.automationToResume,
        dispatch: events.dispatchApprovalDecided, hook: hooks.runOnDecidedHook,
    };
    automationStore.decideApproval = async (id, p) => ({ ...approval, ...p });
    automationStore.appendApprovalAudit = async () => {};
    automationStore.updateRun = async () => true;
    automationStore.closeAwaitingStepRow = async () => 1;
    resumeMod.automationToResume = async () => ({ definition: { edges: [{ from: 'ap', to: 'no', label: 'on_rejected' }] } });
    events.dispatchApprovalDecided = () => {};
    hooks.runOnDecidedHook = async () => ({ ran: false });
    runner.resumeFromStep = async (_runId, _stepId, { decision }) => { decisions.push(decision); return { id: `child-${decisions.length}`, status: 'success' }; };
    try {
        const call = (decision, extra = {}) => finalizeDecision({
            approval, run, deciderId: 'u1', decision, trimmedReason: 'because',
            coercedAnswers: null, source: 'studio', respond: 'finished', ...extra,
        });
        await call('approve');
        await call('reject');
        await call('approve', { coercedAnswers: { note: 'ok' }, votes: [{ voterId: 'u2', decision: 'approve', createdAt: '2026-11-03T10:00:00Z' }] });
    } finally {
        Object.assign(automationStore, {
            decideApproval: saved.decideApproval, appendApprovalAudit: saved.appendApprovalAudit,
            updateRun: saved.updateRun, closeAwaitingStepRow: saved.closeAwaitingStepRow,
        });
        runner.resumeFromStep = saved.resumeFromStep;
        resumeMod.automationToResume = saved.automationToResume;
        events.dispatchApprovalDecided = saved.dispatch;
        hooks.runOnDecidedHook = saved.hook;
    }
    assert.strictEqual(decisions.length, 3);
    for (const d of decisions) assert.deepStrictEqual(Object.keys(d).sort(), CONTRACT);
    assert.deepStrictEqual(decisions.map(d => d.approved), [true, false, true]);
    assert.deepStrictEqual(decisions[2].answers, { note: 'ok' });
    assert.strictEqual(decisions[2].votes.length, 1);
});

test('a dry run (synthesised and harness) and the builder\'s binding shape use the contract keys', async () => {
    require('../entitlements/entitlements').hasCapability = async () => true;
    const { execApproval } = require('../automationRunner');
    const runState = { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
    const definition = { edges: [{ from: 'ap', to: 'no', label: 'on_rejected' }] };

    const synthesised = await execApproval(STEP, { definition }, runState, 'dry_run');
    assert.deepStrictEqual(dataKeys(synthesised.output), CONTRACT, 'synthesised dry run');

    for (const decision of ['approve', 'reject']) {
        const harness = { approvals: { ap: { decision, answers: { note: 'x' } } } };
        const out = await execApproval(STEP, { definition, testHarness: harness }, runState, 'dry_run');
        assert.deepStrictEqual(dataKeys(out.output), CONTRACT, `harness ${decision}`);
        assert.strictEqual(out.output.approved, decision === 'approve');
    }

    const { stepOutputShape } = require('../../automation/builderTools/refCheck');
    const shape = stepOutputShape({ steps: [STEP], edges: [] }, STEP, null);
    assert.deepStrictEqual([...shape.keys.keys()].sort(), CONTRACT, 'builder binding shape');
    assert.strictEqual(shape.sure, true, 'the contract is complete: an unknown key is refused');
});
