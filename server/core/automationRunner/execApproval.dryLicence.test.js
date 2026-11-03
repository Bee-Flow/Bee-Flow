/**
 * The approvals licence is checked in a dry run too (studio F7). An org
 * without it used to see a green dry run and `license_required` on the first
 * real run. Now the dry run records the approval step as an error row with
 * errorClass license_required and a message that says a live run would fail
 * there, and stops, exactly where a live run would. Every dry-run flavour.
 *
 * Stores replaced through automationRunner.testkit; the licence lookup through
 * dryPause.mts's seam. No DB / external services.
 * Run: cd server && node --test core/automationRunner/execApproval.dryLicence.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeMemoryRunStore } = require('../../testUtils/memoryRunStore');
const { installRunnerStoreStubs } = require('../automationRunner.testkit');

const { storeStub } = installRunnerStoreStubs();
const memory = makeMemoryRunStore();
const { stepsByRun } = memory;
Object.assign(storeStub, memory.methods, {
    createRun: async (args) => Object.assign(await memory.methods.createRun(args), {
        isTest: !!args.isTest, startedByUserId: args.startedByUserId ?? null, profile: args.runProfile ?? null,
    }),
});

const { setPauseDepsForTests } = require('./dryPause.mts');
const asked = [];
setPauseDepsForTests({
    hasCapability: async (capId, who) => { asked.push({ capId, orgId: who.orgId }); return false; },
    validateAssignee: async (seat) => seat,
    groupMemberTotal: async () => 1,
});
const runner = require('../automationRunner');

after(() => { setPauseDepsForTests(null); setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(() => { memory.reset(); asked.length = 0; });

function flow() {
    return {
        id: 'auto-lic', version: 1, userId: 'owner-1', organizationId: 'org-starter', title: 'Licence', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'ap', type: 'approval', prompt: 'Ship it?' },
                { id: 'after', type: 'set', fields: { done: { kind: 'literal', value: true } } },
            ],
            edges: [{ from: 'trig', to: 'ap' }, { from: 'ap', to: 'after' }],
        },
    };
}

const rowOf = (runId, stepId) => (stepsByRun.get(runId) || []).find((s) => s.stepId === stepId);

for (const [flavour, opts] of [
    ['synthesise (MCP, API, mobile)', {}],
    ['real pauses (the web builder)', { pausesRequested: true }],
    ['harness (a scenario)', { harness: { source: { kind: 'scenario', id: 's1' }, approvals: { ap: { decision: 'approve', answers: {} } } } }],
]) {
    test(`an unlicensed org: the dry run fails at the approval with a would-fail row (${flavour})`, async () => {
        memory.automation = flow();
        const run = await runner.executeAutomation(memory.automation, { triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: 'tester-1', ...opts });
        assert.strictEqual(run.status, 'error', 'not auto-approved, not paused');
        assert.strictEqual(run.errorClass, 'license_required');
        const row = rowOf(run.id, 'ap');
        assert.strictEqual(row.status, 'error');
        assert.strictEqual(row.errorClass, 'license_required');
        assert.match(row.error, /A live run would fail here/);
        assert.ok(!rowOf(run.id, 'after'), 'nothing after the approval ran');
        assert.deepStrictEqual(asked.at(-1), { capId: 'approvals', orgId: 'org-starter' });
    });
}

test('a live run still fails with the plain message', async () => {
    memory.automation = flow();
    const run = await runner.executeAutomation(memory.automation, { triggerKind: 'manual', mode: 'live' });
    assert.strictEqual(run.status, 'error');
    const row = rowOf(run.id, 'ap');
    assert.strictEqual(row.errorClass, 'license_required');
    assert.doesNotMatch(row.error, /would fail/);
});
