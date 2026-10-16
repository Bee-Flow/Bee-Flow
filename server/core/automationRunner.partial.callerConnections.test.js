/**
 * A partial run (▶ Execute step) is a run: on an automation with
 * runPolicy.connections = 'caller' it must keep the policy (the synthetic
 * definitions for a loop body and a flowlet used to drop it, so the step ran
 * as the OWNER), and it must not replay data from somebody else's caller-mode
 * run.
 *
 * Run: node --test core/automationRunner.partial.callerConnections.test.js
 */

'use strict';

const { test, after } = require('node:test');
require('../automation/runnerPorts');
require('../integrations/runnerPorts');
require('../services/runnerPorts');
const assert = require('node:assert');
const { installRunnerIdentityStubs } = require('../testUtils/runnerIdentityStubs');

const OWNER = 'u-owner';
const EDITOR = 'u-editor';
const USERS = { [OWNER]: { id: OWNER, organizationId: null, orgRole: null }, [EDITOR]: { id: EDITOR, organizationId: null, orgRole: null } };
installRunnerIdentityStubs();

const { installPartialRunHarness } = require('./automationRunner.partial.testkit');
const { runner, storeStub, makeRun, runs, reset } = installPartialRunHarness();
require('../stores/userStore').getUser = async (id) => USERS[id] || null;
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

storeStub.getCallerNoticeAck = async () => [];
const baseCreate = storeStub.createRun;
storeStub.createRun = async (args) => {
    const row = await baseCreate(args);
    row.startedByUserId = args.startedByUserId || null;
    row.connectionsMode = args.connectionsMode || null;
    return row;
};

const POLICY = { connections: 'caller' };
function withLoop(policy) {
    return {
        id: 'auto-1', version: 1, userId: OWNER, organizationId: null, title: 'Loop', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'src', type: 'set', fields: {}, pinnedOutput: { rows: [{ name: 'first' }] } },
                { id: 'lp1', type: 'loop', itemVar: 'row', maxIterations: 10, overRef: 'steps.src.output.rows',
                    body: [{ id: 'B1', type: 'set', fields: { seen: { kind: 'ref', path: 'loop.row.name' } } }] },
            ],
            edges: [{ from: 'trig', to: 'src' }, { from: 'src', to: 'lp1' }],
            ...(policy ? { runPolicy: policy } : {}),
        },
    };
}
function withLayer(policy) {
    return {
        id: 'auto-2', version: 1, userId: OWNER, organizationId: null, title: 'Layer', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'L1', inputs: { x: { kind: 'literal', value: 'v' } } }],
            edges: [{ from: 'trig', to: 'cl1' }],
            layers: { L1: {
                trigger: { id: 'li1', type: 'trigger', kind: 'layer_input', params: [{ name: 'x', type: 'string' }] },
                steps: [{ id: 'A', type: 'set', fields: { echoed: { kind: 'ref', path: 'trigger.output.x' } } },
                    { id: 'out', type: 'layer_output', fields: { result: { kind: 'ref', path: 'steps.A.output.echoed' } } }],
                edges: [{ from: 'li1', to: 'A' }, { from: 'A', to: 'out' }],
            } },
            ...(policy ? { runPolicy: policy } : {}),
        },
    };
}

test('a step inside a loop body runs in caller mode for an editor, and stays an owner run otherwise', async () => {
    reset();
    const caller = await runner.runPartial(withLoop(POLICY), 'lp1/B1', { mode: 'only', startedByUserId: EDITOR });
    assert.strictEqual(caller.status, 'success', caller.error);
    assert.strictEqual(caller.connectionsMode, 'caller');
    const plain = await runner.runPartial(withLoop(null), 'lp1/B1', { mode: 'only', startedByUserId: EDITOR });
    assert.strictEqual(plain.connectionsMode, null);
    const own = await runner.runPartial(withLoop(POLICY), 'lp1/B1', { mode: 'only', startedByUserId: OWNER });
    assert.strictEqual(own.connectionsMode, null, 'the owner pressing it is an owner run');
});

test('a step inside a flowlet keeps the policy too', async () => {
    reset();
    const caller = await runner.runPartial(withLayer(POLICY), 'A', { mode: 'only', startedByUserId: EDITOR });
    assert.strictEqual(caller.status, 'success', caller.error);
    assert.strictEqual(caller.connectionsMode, 'caller');
});

test('the trigger-only partial run records the mode as well', async () => {
    reset();
    const caller = await runner.runPartial(withLoop(POLICY), 'trig', { mode: 'only', startedByUserId: EDITOR, triggerPayload: { a: 1 } });
    assert.strictEqual(caller.connectionsMode, 'caller');
});

test('an editor\'s partial run does not replay the starter\'s data from a caller-mode run; their own runs still seed', async () => {
    reset();
    // A caller-mode run by somebody else, newest in the window, with a "secret" upstream output.
    const callerRun = makeRun({ automationId: 'auto-1', version: 1, userId: OWNER, triggerKind: 'manual', mode: 'live' });
    callerRun.startedByUserId = 'u-starter';
    callerRun.connectionsMode = 'caller';
    await storeStub.recordRunStep({ runId: callerRun.id, stepId: 'src', stepType: 'set', attempts: 1, status: 'success', output: { rows: [{ name: 'SECRET' }] } });
    const automation = withLoop(null);
    automation.definition.steps[0] = { id: 'src', type: 'set', fields: { rows: { kind: 'literal', value: [{ name: 'mine' }] } } };
    const run = await runner.runPartial(automation, 'lp1', { mode: 'only', startedByUserId: EDITOR });
    assert.strictEqual(run.status, 'success', run.error);
    const stepRows = await storeStub.getRunSteps(run.id);
    assert.ok(!JSON.stringify(stepRows).includes('SECRET'), 'the starter\'s value never reaches the editor\'s run');
    assert.ok(runs.size >= 2);
});
