/**
 * builder_request_dry_run (MCP and the AI builder) never pauses: nobody is
 * watching to answer. It asks the runner for pauses 'synthesise' explicitly,
 * and says what it did without a person (tests-and-docs F7, critic gap 6):
 *
 *   - `_warnings` names the auto-approved approval, the form page answered with
 *     blanks and the form trigger that had no answers;
 *   - each such step's `_hint` notes that it was simulated, so the model does
 *     not rebind steps against a blank page it took for ground truth.
 *
 * The real runner on the in-memory run store (automationRunner.testkit); the
 * licence and seat lookups through dryPause.mts's seam.
 * Run: cd server && node --test automation/builderTools.dryRunPause.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeMemoryRunStore } = require('../testUtils/memoryRunStore');
const { installRunnerStoreStubs } = require('../core/automationRunner.testkit');

const { storeStub } = installRunnerStoreStubs();
const memory = makeMemoryRunStore();
const { runs } = memory;
Object.assign(storeStub, memory.methods, {
    createRun: async (args) => Object.assign(await memory.methods.createRun(args), {
        isTest: !!args.isTest, startedByUserId: args.startedByUserId ?? null, profile: args.runProfile ?? null,
    }),
});

const { setPauseDepsForTests } = require('../core/automationRunner/dryPause.mts');
setPauseDepsForTests({ hasCapability: async () => true, validateAssignee: async (seat) => seat, groupMemberTotal: async () => 1 });
const runner = require('../core/automationRunner');
const { applyRequestDryRun } = require('./builderTools/dryRun');
const { _test_dryRunHint: dryRunHint } = require('./builderTools');

after(() => { setPauseDepsForTests(null); setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(memory.reset);

function definition() {
    return {
        trigger: { id: 'trig', type: 'trigger', kind: 'form', form: { title: 'Order', fields: [{ name: 'email', type: 'email', label: 'E-mail' }] } },
        steps: [
            { id: 'ap', type: 'approval', title: 'Manager sign-off', prompt: 'Order for {{trigger.output.email}}?', approval: { fields: [{ name: 'budget', label: 'Budget', type: 'number' }] } },
            { id: 'fp', type: 'form_page', mode: 'input', title: 'Delivery', form: { title: 'Delivery', fields: [{ name: 'street', type: 'text', label: 'Street' }] } },
            { id: 'use', type: 'set', fields: { street: { kind: 'ref', path: 'steps.fp.output.street' }, budget: { kind: 'ref', path: 'steps.ap.output.answers.budget' } } },
        ],
        edges: [{ from: 'trig', to: 'ap' }, { from: 'ap', to: 'fp' }, { from: 'fp', to: 'use' }],
    };
}

function wrapOf(builderSessionId) {
    const def = definition();
    memory.automation = { id: 'auto-mcp', version: 1, userId: 'owner-1', organizationId: null, title: 'Order', triggerType: 'form', definition: def };
    return { userId: 'owner-1', automationId: 'auto-mcp', builderSessionId, title: 'Order', description: '', def };
}

function depsOf(calls) {
    return {
        persistDraft: async () => memory.automation,
        getRunSteps: (runId) => memory.methods.getRunSteps(runId),
        executeAutomation: (a, opts) => { calls.push(opts); return runner.executeAutomation(a, opts); },
        annotate: (s, wrap) => dryRunHint(s, wrap),
    };
}

test('MCP dry run over an approval and a form page: no pause, everything named in _warnings', async () => {
    const calls = [];
    const out = await applyRequestDryRun(wrapOf('mcp_auto-mcp'), {}, depsOf(calls));
    assert.strictEqual(calls[0].origin, 'mcp');
    assert.strictEqual(calls[0].pausesRequested, false, 'pauses synthesise, asked for explicitly');
    assert.strictEqual(out.run.status, 'success', 'nobody is asked, so nothing pauses');
    const profile = runs.get(out.run.id).profile;
    assert.strictEqual(profile.pauses, 'synthesise');
    assert.strictEqual(profile.origin, 'mcp');

    const text = (out._warnings || []).join('\n');
    assert.match(text, /The form trigger had no answers/);
    assert.match(text, /Approval "Manager sign-off" was auto-approved \(simulated\)/);
    assert.match(text, /Form page "Delivery" was answered with blanks \(simulated\)/);
});

test('each simulated step tells the model so in its hint, and the preview stays out of the shape', async () => {
    const out = await applyRequestDryRun(wrapOf('mcp_auto-mcp'), {}, depsOf([]));
    const hint = (id) => out.steps.find((s) => s.stepId === id)._hint;
    assert.match(hint('ap').note, /approval auto-approved \(simulated\)/);
    assert.match(hint('fp').note, /form page answered with blanks \(simulated\)/);
    assert.ok(!hint('ap').topKeys.includes('_preview'), 'the routing preview is not a bindable key');
    assert.ok(hint('ap').topKeys.includes('answers'));
    assert.strictEqual(hint('use').note, undefined);
});

test('the in-product AI builder passes origin builder, still without pausing', async () => {
    const calls = [];
    const out = await applyRequestDryRun(wrapOf('bs_123'), {}, depsOf(calls));
    assert.strictEqual(calls[0].origin, 'builder');
    assert.strictEqual(out.run.status, 'success');
    assert.ok(out._warnings.length >= 2);
});
