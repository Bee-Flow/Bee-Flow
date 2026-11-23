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
const { OWNER_ONLY_NOTIFICATIONS } = require('./plan/planRunCopy.mts');
const { fakeLookups, planOf, supplierRadar, literal } = require('./plan/plan.testkit');

const task = { id: 's1', userId: 'u1', title: 'Supplier radar', repeatInterval: 'daily', nextRunAt: '2026-11-23T07:30:00.000Z' };

function approved(definition = supplierRadar(), over = {}) {
    return { id: 'plan-1', automationId: 'auto-1', definition, fingerprint: planFingerprint(definition), ...over };
}

function harness({ plan = approved(), claim = 'run-1', automation = { id: 'auto-1', userId: 'u1', definition: { steps: [{ id: 'other', type: 'code' }] }, version: 7 }, run = { id: 'arun-1', status: 'success', summary: 'Ran 7 steps.' }, mayAsk = false, policy = { ceiling: 'on_its_own', readOnly: false, unattendedApps: null }, approver = null, lastGoodStart = null } = {}) {
    const calls = [];
    const rec = (name, answer) => async (...a) => { calls.push([name, ...a]); return answer; };
    const store = {
        markRunning: rec('markRunning', claim), getApprovedPlan: rec('getApprovedPlan', plan), linkPlanRun: rec('linkPlanRun'),
        markCompleted: rec('markCompleted'),
    };
    const seen = { executed: [], failed: [], notes: [], advanced: [] };
    const deps = {
        failRun: async (t, err, opts) => { seen.failed.push({ err, opts }); },
        advance: async (t, opts) => { seen.advanced.push(opts); calls.push(['advance']); },
        NOTIFICATION: { category: 'cowork', link: null, prefix: '' },
        getAutomation: async () => automation,
        isManaged: async (a) => a.projectId === 'stage-project',
        executeAutomation: async (a, opts) => { seen.executed.push({ automation: a, opts }); await opts.onRunCreated({ id: run.id }); return run; },
        createNotification: async (n) => { seen.notes.push(n); },
        lookups: fakeLookups(),
        mayAsk: async () => mayAsk,
        policyOf: async () => policy,
        trustOf: async () => [],
        approverOf: async () => approver,
        since: { lastGoodRunStart: rec('lastGoodRunStart', lastGoodStart) },
    };
    return { store, calls, seen, deps, names: () => calls.map((c) => c[0]) };
}

test('it runs the approved copy, live, as the owner: never the automation\'s own definition of the moment', async () => {
    const h = harness();
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.executed.length, 1);
    const { automation, opts } = h.seen.executed[0];
    const { notificationSettings, ...steps } = automation.definition;
    assert.deepStrictEqual(steps, supplierRadar(), 'the plan as approved');
    assert.strictEqual(notificationSettings, OWNER_ONLY_NOTIFICATIONS);
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
        ['linkPlanRun', 'run-1', { planId: 'plan-1', independence: 'on_its_own', trustedSteps: [] }],
        ['linkPlanRun', 'run-1', { planId: 'plan-1', automationRunId: 'arun-1' }],
    ]);
});

test('the level decides the questions: a run that may ask, asks before what it sends; a choice to be asked that cannot be honoured runs nothing', async () => {
    const sends = planOf([...supplierRadar().steps.slice(0, 6), { id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('x@supplier.example') } }]);
    const asked = harness({ plan: approved(sends), mayAsk: true });
    await executePlanRun(task, { store: asked.store, manual: true }, asked.deps);
    const ran = asked.seen.executed[0].automation.definition.steps.map((/** @type {any} */ st) => st.id);
    assert.deepStrictEqual(ran.slice(-2), ['cowork_ask__send', 'send'], 'the default where asking is possible: ask before sending');
    assert.deepStrictEqual(asked.calls.find((c) => c[0] === 'linkPlanRun')?.[2], { planId: 'plan-1', independence: 'asks_before_sending', trustedSteps: [] });

    const refused = harness({ plan: approved(sends), mayAsk: false });
    await executePlanRun({ ...task, independence: 'asks_everything' }, { store: refused.store, manual: true }, refused.deps);
    assert.deepStrictEqual(refused.seen.executed, [], 'nothing ran');
    assert.match(refused.seen.failed[0]?.err.message ?? '', /asking needs approvals/);
});

test('the automation\'s own time limit is held to Cowork\'s, so the engine ends the run before Cowork\'s reaper would', async () => {
    const h = harness({ automation: { id: 'auto-1', userId: 'u1', runTimeoutMs: 45 * 60_000, version: 7 } });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.executed[0].automation.runTimeoutMs, require('./runDeadline.mts').runMaxMs());
});

test('the schedule moves on before the run says it is no longer running', async () => {
    const h = harness();
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.ok(h.names().indexOf('advance') < h.names().indexOf('markCompleted'), h.names().join(', '));
});

test('a finished run closes its row with what it produced and moves the schedule on', async () => {
    const h = harness({ run: { id: 'arun-1', status: 'success', summary: 'Ran 7 steps.', lastOutput: { body: '9 orders, 2 overdue.' } } });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.deepStrictEqual(h.calls.find((c) => c[0] === 'markCompleted'), ['markCompleted', 's1', '9 orders, 2 overdue.', { runId: 'run-1', waiting: false }]);
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
    const definition = planOf([{ id: 'c', type: 'parallel' }]);
    const h = harness({ plan: approved(definition) });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.executed.length, 0);
    assert.match(h.seen.failed[0].err.message, /may not run as it is: A plan runs its steps one after another/);
});

test('an item whose plan was taken off between the tick and the run does not run', async () => {
    const h = harness({ plan: null });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    assert.strictEqual(h.seen.executed.length, 0);
    assert.match(h.seen.failed[0].err.message, /no approved plan any more/);
});

test('an automation that is gone, or that is someone else\'s now, lends its identity to nobody', async () => {
    // The last one is the owner's, but a Solution stage manages it: its runs are the stage's (./plan/planSource.mts).
    for (const automation of [null, { id: 'auto-1', userId: 'someone-else' }, { id: 'auto-1', userId: 'u1', kind: 'block' }, { id: 'auto-1', userId: 'u1', projectId: 'stage-project' }]) {
        const h = harness({ automation });
        await executePlanRun(task, { store: h.store, due: true }, h.deps);
        assert.strictEqual(h.seen.executed.length, 0, JSON.stringify(automation));
        assert.match(h.seen.failed[0].err.message, /gone or is no longer yours/);
    }
});

test('a plan run never uses the automation\'s own notification settings: nothing about it reaches another person or a room', async () => {
    const withSettings = { ...supplierRadar(), notificationSettings: { onError: { enabled: true, channels: ['talk'], recipients: [{ type: 'group', id: 'g1' }], talkRoom: 'ops' }, onSuccess: { enabled: true, channels: ['email'], recipients: [{ type: 'user', id: 'u9' }] } } };
    const h = harness({ plan: approved(withSettings) });
    await executePlanRun(task, { store: h.store, due: true }, h.deps);
    const settings = h.seen.executed[0].automation.definition.notificationSettings;
    assert.deepStrictEqual([settings.onError.enabled, settings.onSuccess.enabled], [false, false], 'Cowork tells the owner itself, once');
    assert.deepStrictEqual([settings.onApproval.channels, settings.onApproval.recipients], [['bell'], [{ type: 'owner' }]]);
    assert.ok(!JSON.stringify(settings).includes('ops') && !JSON.stringify(settings).includes('g1') && !JSON.stringify(settings).includes('u9'));
    assert.strictEqual(h.seen.failed.length, 0, 'the approved plan itself still has its fingerprint');
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
    const [, , text, close] = h.calls.find((c) => c[0] === 'markCompleted');
    assert.match(text, /waiting for a decision/);
    assert.deepStrictEqual(close, { runId: 'run-1', waiting: true }, 'closed as waiting, for the follow-up to close for good');
    assert.strictEqual(h.seen.notes.length, 1, 'the plan did not reach its own result step yet');
    assert.deepStrictEqual(h.seen.failed, []);
});

test('a plan that ends in a result step produced the message it delivered, not the engine\'s list of its steps', () => {
    const row = { lastOutput: { delivered: { title: 'Supplier radar', body: '3 orders are overdue', channels: ['notification'] } }, summary: '**Trigger:** When run manually.' };
    assert.strictEqual(resultTextOf(row), '3 orders are overdue');
    assert.strictEqual(resultTextOf({ lastOutput: { delivered: 'odd' }, summary: 'Ran.' }), 'Ran.');
});

test('what a run produced is the text of its last step, else the runner\'s summary, never nothing', () => {
    assert.strictEqual(resultTextOf({ lastOutput: { body: 'A digest.' }, summary: 'Ran.' }), 'A digest.');
    assert.strictEqual(resultTextOf({ lastOutput: { text: 'An answer.' } }), 'An answer.');
    assert.strictEqual(resultTextOf({ lastOutput: 'Plain text.' }), 'Plain text.');
    assert.strictEqual(resultTextOf({ lastOutput: { rows: [1, 2] }, summary: 'Ran 3 steps.' }), 'Ran 3 steps.');
    assert.strictEqual(resultTextOf({ lastOutput: { body: '   ' }, summary: '' }), 'Done.');
    assert.strictEqual(resultTextOf(null), 'Done.');
});

test('the organisation\'s policy: its ceiling holds the level down, and an app it does not let run unattended stops the plan', async () => {
    const sends = planOf([...supplierRadar().steps.slice(0, 6), { id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('x@supplier.example') } }]);
    const capped = harness({ plan: approved(sends), mayAsk: true, policy: { ceiling: 'asks_everything', readOnly: false, unattendedApps: null } });
    await executePlanRun({ ...task, independence: 'on_its_own' }, { store: capped.store, manual: true }, capped.deps);
    assert.deepStrictEqual(capped.calls.find((c) => c[0] === 'linkPlanRun')?.[2], { planId: 'plan-1', independence: 'asks_everything', trustedSteps: [] });

    const fenced = harness({ plan: approved(sends), mayAsk: true, policy: { ceiling: 'on_its_own', readOnly: false, unattendedApps: ['datatables'] } });
    await executePlanRun(task, { store: fenced.store, manual: true }, fenced.deps);
    assert.deepStrictEqual(fenced.seen.executed, [], 'nothing ran');
    assert.match(fenced.seen.failed[0]?.err.message ?? '', /does not let outlook run while nobody watches/);
});

test('a plan run knows when the last good run started: {{trigger.output.since}}, read from the item\'s runs', async () => {
    const h = harness({ lastGoodStart: '2026-11-22T06:30:00.000Z' });
    // The item says its last run failed: that does not empty "since".
    await executePlanRun({ ...task, lastRunAt: '2026-11-23T06:31:00.000Z', lastStatus: 'error' }, { store: h.store, manual: true }, h.deps);
    const payload = h.seen.executed[0].opts.triggerPayload;
    assert.strictEqual(payload.since, '2026-11-22T06:30:00.000Z');
    assert.deepStrictEqual(h.calls.find((c) => c[0] === 'lastGoodRunStart'), ['lastGoodRunStart', 's1']);
    assert.ok(typeof payload.now === 'string' && payload.now.endsWith('Z'));
});

test('a plan\'s scripts are marked to run outside the API process, inside loops too; the author\'s own value never decides', async () => {
    const definition = planOf([
        { id: 'sum', type: 'code', code: 'return 1', isolated: false },
        { id: 'each', type: 'loop', items: literal([1, 2]), body: [{ id: 'inner', type: 'code', code: 'return 2' }] },
    ]);
    const h = harness({ plan: approved(definition) });
    await executePlanRun(task, { store: h.store, manual: true }, h.deps);
    const steps = h.seen.executed[0].automation.definition.steps;
    assert.deepStrictEqual([steps[0].isolated, steps[1].body[0].isolated], [true, true]);
});

test('a colleague the owner named to decide gets the questions: they are assigned to them', async () => {
    const sends = planOf([...supplierRadar().steps.slice(0, 6), { id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('x@supplier.example') } }]);
    const h = harness({ plan: approved(sends), mayAsk: true, approver: 'u-colleague' });
    await executePlanRun(task, { store: h.store, manual: true }, h.deps);
    const question = h.seen.executed[0].automation.definition.steps.find((/** @type {any} */ st) => st.id === 'cowork_ask__send');
    assert.deepStrictEqual(question.approval, { assignee: { userId: 'u-colleague' } });
});

test('a run an event started is not the item\'s moment: it moves no clock and never switches a one-off item off, also when it fails', async () => {
    const h = harness();
    await executePlanRun(task, { store: h.store, trigger: { runId: 'ev-1', plan: true, payload: { start: 'webhook' } } }, h.deps);
    assert.deepStrictEqual(h.seen.advanced.map((o) => o.manual), [true]);
    const failing = harness({ plan: null });
    await executePlanRun(task, { store: failing.store, trigger: { runId: 'ev-2', plan: true, payload: {} } }, failing.deps);
    assert.deepStrictEqual(failing.seen.failed.map((f) => f.opts.manual), [true]);
});
