/**
 * A run says when a mapping found nothing.
 *
 * A ref that resolved to nothing, a formula that threw and a `{{…}}` with no
 * data behind it used to leave the step with an empty value and the run
 * green, with no line anywhere. The runner now opens a binding log around
 * every step (bind.withBindingLog) and:
 *   - hands the step's misses to recordRunStep as `bindingWarnings`;
 *   - adds one readable line per miss to the run's warnings
 *     (runState._templateWarnings);
 *   - says it in the run summary, which the run list and the dry-run panel
 *     show: "… — 2 mappings found nothing: s1: input "to" read …".
 *
 * Run: cd server && node --test core/automationRunner/execution.bindingMisses.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.NODE_ENV = 'test';

// The real store module, its methods replaced for this file (no module-system
// stubbing: execution.js reads `automationStore.<fn>` at call time).
const automationStore = require('../../stores/automationStore');

let ops = [];
const storeStub = {
    createRun: async (row) => { const r = { id: 'run-1', ...row }; ops.push({ op: 'createRun', row: r }); return r; },
    updateRun: async (id, patch) => { ops.push({ op: 'updateRun', id, patch }); return { id, ...patch }; },
    getRun: async (id) => {
        const last = [...ops].reverse().find(o => o.op === 'updateRun');
        return last ? { id, ...last.patch } : { id, automationId: 'a1', status: 'running' };
    },
    getAutomation: async () => null,
    getRunSteps: async () => [],
    getRunStepsForRuns: async () => [],
    getRunsForAutomation: async () => [],
    markRunning: async () => true,
    advanceSchedule: async () => {},
    getRunTokenMap: async () => ({}),
    saveRunTokenMap: async () => true,
    isCancelRequested: async () => false,
    recordRunStep: async (row) => { ops.push({ op: 'recordRunStep', row }); return { id: 'step-1' }; },
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    touchAutomationRunning: async () => {},
    touchRunHeartbeat: async () => {},
    updateAutomation: async () => {},
};
const originals = {};
for (const [k, fn] of Object.entries(storeStub)) { originals[k] = automationStore[k]; automationStore[k] = fn; }
test.after(() => Object.assign(automationStore, originals));

const { executeAutomation } = require(path.join(__dirname, 'execution.js'));

const definition = (fields) => ({
    trigger: { id: 't', type: 'trigger', kind: 'manual' },
    steps: [{ id: 's1', type: 'set', fields }],
    edges: [{ from: 't', to: 's1' }],
});

async function run(fields) {
    ops = [];
    await executeAutomation({ id: 'a1', name: 'x', user_id: 'u1', is_active: true, definition: definition(fields) }, {
        triggerKind: 'manual',
        triggerPayload: { contact: { email: 'a@x.nl' } },
    });
    const stepRow = ops.filter(o => o.op === 'recordRunStep' && o.row.stepId === 's1' && o.row.status !== 'running').pop()?.row;
    const terminal = ops.filter(o => o.op === 'updateRun' && o.patch && o.patch.finishedAt).pop()?.patch;
    return { stepRow, terminal };
}

test('the step row carries the misses and the summary says so', async () => {
    const { stepRow, terminal } = await run({
        to: { kind: 'ref', path: 'trigger.output.contact.e-mail' },
        ok: { kind: 'ref', path: 'trigger.output.contact.email' },
        later: { kind: 'template', value: 'Hi {{steps.nope.output.name}}' },
    });
    assert.ok(stepRow, 'the step was recorded');
    assert.equal(stepRow.status, 'success');
    assert.deepEqual(stepRow.bindingWarnings.map(w => [w.field, w.reason]), [['to', 'missing'], ['later', 'not_run']]);
    assert.match(terminal.summary, /2 mappings found nothing/);
    assert.match(terminal.summary, /s1: input "to" read trigger\.output\.contact\.e-mail/);
});

test('a run whose mappings all resolve says nothing extra', async () => {
    const { stepRow, terminal } = await run({ ok: { kind: 'ref', path: 'trigger.output.contact.email' } });
    assert.equal(stepRow.bindingWarnings ?? null, null);
    assert.doesNotMatch(terminal.summary || '', /found nothing/);
});
