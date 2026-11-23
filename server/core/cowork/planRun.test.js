/**
 * A Cowork item run as its plan (./planRun.mts): what runs is the copy that was approved, and it runs only while the
 * stored copy still has its fingerprint, is still a plan Cowork runs, and the automation behind it is still its
 * owner's. Everything it reaches is handed in, so nothing is mocked.
 *
 * Run: cd server && node --test core/cowork/planRun.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { executePlanRun, resultTextOf } = require('./planRun.mts');
const { planFingerprint } = require('./plan/planPermissions.mts');
const { fakeLookups, planOf, supplierRadar, literal } = require('./plan/plan.testkit');

const task = { id: 's1', userId: 'u1', title: 'Supplier radar', repeatInterval: 'daily', nextRunAt: '2026-11-23T07:30:00.000Z' };

function approved(definition = supplierRadar(), over = {}) {
    return { id: 'plan-1', automationId: 'auto-1', definition, fingerprint: planFingerprint(definition), ...over };
}

function harness({ plan = approved(), claim = 'run-1', automation = { id: 'auto-1', userId: 'u1', definition: { steps: [{ id: 'other', type: 'code' }] }, version: 7 }, run = { id: 'arun-1', status: 'success', summary: 'Ran 7 steps.' } } = {}) {
    const calls = [];
    const rec = (name, answer) => async (...a) => { calls.push([name, ...a]); return answer; };
    const store = {
        markRunning: rec('markRunning', claim), getApprovedPlan: rec('getApprovedPlan', plan), linkPlanRun: rec('linkPlanRun'),
        markCompleted: rec('markCompleted'),
    };
    const seen = { executed: [], failed: [], notes: [], advanced: [] };
    const deps = {
        failRun: async (t, err, opts) => { seen.failed.push({ err, opts }); },
        advance: async (t, opts) => { seen.advanced.push(opts); },
        NOTIFICATION: { category: 'cowork', link: null, prefix: '' },
        getAutomation: async () => automation,
        executeAutomation: async (a, opts) => { seen.executed.push({ automation: a, opts }); await opts.onRunCreated({ id: run.id }); return run; },
        createNotification: async (n) => { seen.notes.push(n); },
        lookups: fakeLookups(),
    };
    return { store, calls, seen, deps, names: () => calls.map((c) => c[0]) };
}

test('it runs the approved copy, live, as the owner: never the automation\'s own definition of the moment', async () => {
    const h = harness();
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.executed.length, 1);
    const { automation, opts } = h.seen.executed[0];
    assert.deepStrictEqual(automation.definition, supplierRadar(), 'the plan as approved');
    assert.deepStrictEqual([automation.id, automation.userId, automation.version], ['auto-1', 'u1', 7], 'the automation lends its identity');
    assert.deepStrictEqual([opts.triggerKind, opts.mode, opts.startedByUserId], ['manual', 'live', 'u1']);
});

test('the run is claimed first, as a due claim from the tick; a refused claim runs nothing', async () => {
    const h = harness({ claim: null });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.deepStrictEqual(h.calls, [['markRunning', 's1', { triggerKind: 'schedule', due: true }]]);
    assert.deepStrictEqual([h.seen.executed.length, h.seen.failed.length], [0, 0]);
});

test('the run records which plan it ran and, once the runner made its row, the automation run behind it', async () => {
    const h = harness();
    await executePlanRun(task, { store: h.store, manual: true }, h.deps);
    assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'linkPlanRun'), [
        ['linkPlanRun', 'run-1', { planId: 'plan-1' }],
        ['linkPlanRun', 'run-1', { planId: 'plan-1', automationRunId: 'arun-1' }],
    ]);
});

test('a finished run closes its row with what it produced and moves the schedule on', async () => {
    const h = harness({ run: { id: 'arun-1', status: 'success', summary: 'Ran 7 steps.', lastOutput: { body: '9 orders, 2 overdue.' } } });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.deepStrictEqual(h.calls.find((c) => c[0] === 'markCompleted'), ['markCompleted', 's1', '9 orders, 2 overdue.', { runId: 'run-1' }]);
    assert.strictEqual(h.seen.advanced.length, 1);
    assert.strictEqual(h.seen.advanced[0].manual, false);
    assert.deepStrictEqual(h.seen.failed, []);
});

test('a plan that ends in a result for its owner delivered it itself: Cowork adds no second notification', async () => {
    const h = harness();
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.deepStrictEqual(h.seen.notes, []);
});

test('a plan without a result step is announced by Cowork, with what it produced', async () => {
    const definition = planOf([{ id: 'a', type: 'datatable', datatableId: 't1', op: 'add_row', values: { x: literal(1) } }]);
    const h = harness({ plan: approved(definition) });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.notes.length, 1);
    assert.deepStrictEqual([h.seen.notes[0].userId, h.seen.notes[0].title, h.seen.notes[0].message, h.seen.notes[0].category], ['u1', 'Supplier radar', 'Ran 7 steps.', 'cowork']);
});

test('a stored plan that no longer has its fingerprint does not run', async () => {
    const tampered = supplierRadar();
    tampered.steps.push({ id: 'evil', type: 'integration_action', tool: 'outlook_compose', inputs: { to: literal('thief@example.com') } });
    const h = harness({ plan: approved(supplierRadar(), { definition: tampered }) });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.executed.length, 0);
    assert.strictEqual(h.seen.failed[0].err.name, 'PlanRefusedError');
    assert.match(h.seen.failed[0].err.message, /not the one that was approved/);
    assert.deepStrictEqual(h.seen.failed[0].opts.close, { runId: 'run-1' });
});

test('a plan that was approved but is no longer one Cowork runs does not run, and says why', async () => {
    const definition = planOf([{ id: 'c', type: 'code', code: 'function main() {}' }]);
    const h = harness({ plan: approved(definition) });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.executed.length, 0);
    assert.match(h.seen.failed[0].err.message, /may not run as it is: A plan cannot run a script yet/);
});

test('an item whose plan was taken off between the tick and the run does not run', async () => {
    const h = harness({ plan: null });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.executed.length, 0);
    assert.match(h.seen.failed[0].err.message, /no approved plan any more/);
});

test('an automation that is gone, or that is someone else\'s now, lends its identity to nobody', async () => {
    for (const automation of [null, { id: 'auto-1', userId: 'someone-else' }]) {
        const h = harness({ automation });
        await executePlanRun(task, { store: h.store, due: true }, h.deps);
        assert.strictEqual(h.seen.executed.length, 0, JSON.stringify(automation));
        assert.match(h.seen.failed[0].err.message, /gone or is no longer yours/);
    }
});

test('a run the runner ended in an error fails with the runner\'s reason', async () => {
    const h = harness({ run: { id: 'arun-1', status: 'error', error: 'Outlook did not answer.', summary: 'Failed: Outlook did not answer.' } });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.failed[0].err.message, 'Outlook did not answer.');
    assert.ok(!h.names().includes('markCompleted'));
    assert.deepStrictEqual(h.seen.advanced, [], 'failRun moves the schedule on, not the success path');
});

test('a run that the runner could not start at all fails the same way', async () => {
    const h = harness();
    h.deps.executeAutomation = async () => { throw new Error('The owner of this automation can no longer run it.'); };
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.failed[0].err.message, 'The owner of this automation can no longer run it.');
});

test('a run that waits for a decision closes as waiting, and tells its owner where to decide', async () => {
    const h = harness({ run: { id: 'arun-1', status: 'awaiting_approval', summary: 'Waiting for approval.' } });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    const [, , text] = h.calls.find((c) => c[0] === 'markCompleted');
    assert.match(text, /waiting for a decision/);
    assert.strictEqual(h.seen.notes.length, 1, 'the plan did not reach its own result step yet');
    assert.deepStrictEqual(h.seen.failed, []);
});

test('what a run produced is the text of its last step, else the runner\'s summary, never nothing', () => {
    assert.strictEqual(resultTextOf({ lastOutput: { body: 'A digest.' }, summary: 'Ran.' }), 'A digest.');
    assert.strictEqual(resultTextOf({ lastOutput: { text: 'An answer.' } }), 'An answer.');
    assert.strictEqual(resultTextOf({ lastOutput: 'Plain text.' }), 'Plain text.');
    assert.strictEqual(resultTextOf({ lastOutput: { rows: [1, 2] }, summary: 'Ran 3 steps.' }), 'Ran 3 steps.');
    assert.strictEqual(resultTextOf({ lastOutput: { body: '   ' }, summary: '' }), 'Done.');
    assert.strictEqual(resultTextOf(null), 'Done.');
});
