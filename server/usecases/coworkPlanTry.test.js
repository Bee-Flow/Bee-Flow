/**
 * "Try it first" (./coworkPlanTry.mts): starting a dry run of an item's plan and reading it step by step. The
 * automation lookup, the owner gate and the runner are handed in, so nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkPlanTry.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { startTry, tryStateOf } = require('./coworkPlanTry.mts');
const { planFingerprint } = require('../core/cowork/plan/planPermissions.mts');
const { fakeLookups, planOf, supplierRadar } = require('../core/cowork/plan/plan.testkit');

const ITEM = { id: 's1', userId: 'u1', planAutomationId: 'auto-1' };

function world({ automation = { id: 'auto-1', userId: 'u1', organizationId: 'org-1', kind: 'automation', definition: supplierRadar() }, refusal = null, run = { id: 'try-1', automationId: 'auto-1', mode: 'dry_run', status: 'running' }, steps = [], mayAsk = true } = {}) {
    const seen = { executed: [] };
    const deps = {
        getAutomation: async () => automation,
        isManaged: async (a) => a.projectId === 'stage-project',
        mayAsk: async () => mayAsk,
        ownerRefusal: async () => refusal,
        executeAutomation: async (a, opts) => {
            seen.executed.push({ automation: a, opts });
            opts.onRunCreated({ id: 'try-1' });
            return { id: 'try-1', status: 'success' };
        },
        getRun: async (id) => (run && id === run.id ? run : null),
        getRunSteps: async () => steps,
        lookups: fakeLookups(),
    };
    return { deps, seen };
}

const httpError = (status, code) => (err) => err.status === status && err.code === code;

test('a try-out is a dry run of the plan as it is now, started as its owner, and answers with its id and fingerprint', async () => {
    const { deps, seen } = world();
    const started = await startTry({ item: ITEM }, deps);
    assert.deepStrictEqual(started, { tryId: 'try-1', fingerprint: planFingerprint(supplierRadar()) });
    const { automation, opts } = seen.executed[0];
    assert.deepStrictEqual(automation.definition, supplierRadar());
    assert.deepStrictEqual([opts.triggerKind, opts.mode, opts.startedByUserId, opts.pausesRequested], ['dry_run', 'dry_run', 'u1', false]);
});

test('it answers as soon as the run exists, while the run itself is still going', async () => {
    const { deps } = world();
    let finish = () => {};
    deps.executeAutomation = (a, opts) => { opts.onRunCreated({ id: 'try-7' }); return new Promise((resolve) => { finish = () => resolve({ id: 'try-7', status: 'success' }); }); };
    const started = await startTry({ item: ITEM }, deps);
    assert.strictEqual(started.tryId, 'try-7');
    finish();
});

test('a run that fails after its id was handed out fails nobody: its own row says how it ended', async () => {
    const { deps } = world();
    deps.executeAutomation = async (a, opts) => { opts.onRunCreated({ id: 'try-8' }); throw new Error('Outlook did not answer.'); };
    assert.strictEqual((await startTry({ item: ITEM }, deps)).tryId, 'try-8');
});

test('a run that never started is an error the caller sees', async () => {
    const { deps } = world();
    deps.executeAutomation = async () => { throw new Error('The owner of this automation can no longer run it.'); };
    await assert.rejects(startTry({ item: ITEM }, deps), /can no longer run it/);
});

test('a plan with a finding is not tried, an owner the runner refuses neither, and nothing runs', async () => {
    const blocked = world({ automation: { id: 'auto-1', userId: 'u1', definition: planOf([{ id: 'c', type: 'parallel' }]) } });
    await assert.rejects(startTry({ item: ITEM }, blocked.deps), (err) => err.status === 422 && /cannot be tried yet: A plan runs its steps one after another/.test(err.message));
    const refused = world({ refusal: 'not_entitled' });
    await assert.rejects(startTry({ item: ITEM }, refused.deps), httpError(403, 'cowork_plan_refused'));
    assert.strictEqual(blocked.seen.executed.length + refused.seen.executed.length, 0);
});

test('a plan with a step that waits for a decision is not tried where the licence has no approvals', async () => {
    const withAsk = planOf([{ id: 'facts', type: 'set', fields: {} }, { id: 'ask', type: 'approval', prompt: 'Send it?' }]);
    const w = world({ automation: { id: 'auto-1', userId: 'u1', organizationId: 'org-1', definition: withAsk }, mayAsk: false });
    await assert.rejects(startTry({ item: ITEM }, w.deps), (err) => err.status === 422 && /needs approvals/.test(err.message));
    assert.strictEqual(w.seen.executed.length, 0);
});

test('an item without a plan, or whose automation is gone or someone else\'s, has nothing to try', async () => {
    const managed = { id: 'auto-1', userId: 'u1', projectId: 'stage-project', definition: supplierRadar() };
    for (const w of [world({ automation: null }), world({ automation: { id: 'auto-1', userId: 'someone-else', definition: supplierRadar() } }), world({ automation: managed })]) {
        await assert.rejects(startTry({ item: ITEM }, w.deps), httpError(409, 'cowork_plan_refused'));
    }
    await assert.rejects(startTry({ item: { ...ITEM, planAutomationId: null } }, world().deps), httpError(409, 'cowork_plan_refused'));
});

test('reading a try-out lists every plan step in order: reached ones with their status and time, the rest pending', async () => {
    const steps = [
        { stepId: 'mail', attempts: 1, status: 'success', startedAt: '2026-11-23T09:14:00.000Z', finishedAt: '2026-11-23T09:14:01.200Z', output: { messages: [{ subject: 'Order 24-1187' }] } },
        { stepId: 'orders', attempts: 1, status: 'running', startedAt: '2026-11-23T09:14:01.300Z', finishedAt: null },
    ];
    const state = await tryStateOf({ item: ITEM, tryId: 'try-1' }, world({ steps }).deps);
    assert.deepStrictEqual([state.tryId, state.status, state.done], ['try-1', 'running', false]);
    assert.deepStrictEqual(state.steps.map((s) => [s.id, s.status, s.durationMs]), [
        ['mail', 'success', 1200], ['orders', 'running', null], ['overdue', 'pending', null], ['table', 'pending', null],
        ['reply', 'pending', null], ['draft', 'pending', null], ['digest', 'pending', null],
    ]);
    assert.match(state.steps[0].preview, /Order 24-1187/);
});

test('a reading step shows what it got; a step that would change or send shows what it would have sent, never its made-up answer', async () => {
    const steps = [
        { stepId: 'mail', attempts: 1, status: 'success', output: { messages: 9 }, input: { query: 'from:suppliers' } },
        { stepId: 'draft', attempts: 1, status: 'success', input: { to: 'orders@hoekstra-staal.example', body: 'Dear Mr Hoekstra' }, output: { id: 'sample-draft-id', _dryRun: true } },
        { stepId: 'table', attempts: 1, status: 'success', input: { values: { amount: 12480 } }, output: { rowId: 'sample' } },
    ];
    const byId = Object.fromEntries((await tryStateOf({ item: ITEM, tryId: 'try-1' }, world({ steps }).deps)).steps.map((s) => [s.id, s]));
    assert.deepStrictEqual([byId.mail.held, byId.draft.held, byId.table.held, byId.digest.held], [false, true, true, true]);
    assert.match(byId.mail.preview, /"messages": 9/);
    assert.match(byId.draft.preview, /hoekstra-staal/);
    assert.ok(!/sample-draft-id/.test(byId.draft.preview), 'the simulated answer is not shown');
    assert.match(byId.table.preview, /12480/);
});

test('the last attempt of a step is the one that counts, and a failed step carries its reason', async () => {
    const steps = [
        { stepId: 'mail', attempts: 1, status: 'error', error: 'Outlook did not answer.' },
        { stepId: 'mail', attempts: 2, status: 'success', output: { messages: 3 } },
        { stepId: 'orders', attempts: 1, status: 'error', error: 'The model did not answer.' },
    ];
    const state = await tryStateOf({ item: ITEM, tryId: 'try-1' }, world({ steps, run: { id: 'try-1', automationId: 'auto-1', mode: 'dry_run', status: 'error', error: 'The model did not answer.', summary: 'Failed.', durationMs: 4200 } }).deps);
    assert.deepStrictEqual([state.steps[0].status, state.steps[0].error], ['success', null]);
    assert.deepStrictEqual([state.steps[1].status, state.steps[1].error], ['error', 'The model did not answer.']);
    assert.deepStrictEqual([state.done, state.status, state.error, state.summary, state.durationMs], [true, 'error', 'The model did not answer.', 'Failed.', 4200]);
});

test('a step inside a loop goes by its loop, and a step a finished run never came to is "not reached"', async () => {
    const definition = planOf([
        { id: 'mail', type: 'integration_action', tool: 'outlook_search' },
        { id: 'each', type: 'loop', overRef: '{{steps.mail.output.messages}}', body: [{ id: 'reply', type: 'ai_step', prompt: 'Answer {{loop.item.subject}}' }] },
        { id: 'digest', type: 'notification', title: 'Done' },
    ]);
    const automation = { id: 'auto-1', userId: 'u1', definition };
    const steps = [{ stepId: 'mail', attempts: 1, status: 'success', output: { messages: 2 } }, { stepId: 'each', attempts: 1, status: 'running' }];
    const going = await tryStateOf({ item: ITEM, tryId: 'try-1' }, world({ automation, steps }).deps);
    assert.deepStrictEqual(going.steps.map((s) => [s.id, s.status, s.depth]), [['mail', 'success', 0], ['each', 'running', 0], ['reply', 'running', 1], ['digest', 'pending', 0]]);

    const failed = [steps[0], { stepId: 'each', attempts: 1, status: 'error', error: 'The model did not answer.' }];
    const over = await tryStateOf({ item: ITEM, tryId: 'try-1' }, world({ automation, steps: failed, run: { id: 'try-1', automationId: 'auto-1', mode: 'dry_run', status: 'error' } }).deps);
    assert.deepStrictEqual(over.steps.map((s) => [s.id, s.status]), [['mail', 'success'], ['each', 'error'], ['reply', 'error'], ['digest', 'not_reached']]);
    assert.strictEqual(over.steps[2].preview, null, 'a looped step has no preview of its own');
});

test('a try-out belongs to its item: a run of another automation, a live run and an unknown id are all "does not exist"', async () => {
    const other = world({ run: { id: 'try-1', automationId: 'auto-2', mode: 'dry_run', status: 'success' } });
    await assert.rejects(tryStateOf({ item: ITEM, tryId: 'try-1' }, other.deps), httpError(404, 'cowork_plan_refused'));
    const live = world({ run: { id: 'try-1', automationId: 'auto-1', mode: 'live', status: 'success' } });
    await assert.rejects(tryStateOf({ item: ITEM, tryId: 'try-1' }, live.deps), httpError(404, 'cowork_plan_refused'));
    await assert.rejects(tryStateOf({ item: ITEM, tryId: 'no-such-run' }, world().deps), httpError(404, 'cowork_plan_refused'));
});

test('a try-out in which a step found no list in what the step before it really returned is no pass: it says why', async () => {
    const definition = planOf([
        { id: 'list', type: 'integration_action', label: 'List meetings', tool: 'fireflies_list_transcripts', inputs: {} },
        { id: 'sums', type: 'integration_action', label: 'Get summaries', tool: 'fireflies_get_summary', forEach: { overRef: 'steps.list.output.transcripts', itemVar: 't' }, inputs: {} },
    ]);
    const steps = [
        { stepId: 'list', attempts: 1, status: 'success', output: { results: [{ id: 't1' }], count: 1, message: 'Found 1 transcript(s).' } },
        { stepId: 'sums', attempts: 1, status: 'skipped', output: { iterations: 0, results: [] } },
    ];
    const run = { id: 'try-1', automationId: 'auto-1', mode: 'dry_run', status: 'success' };
    const automation = { id: 'auto-1', userId: 'u1', organizationId: 'org-1', kind: 'automation', definition };
    const state = await tryStateOf({ item: ITEM, tryId: 'try-1' }, world({ automation, run, steps }).deps);
    assert.strictEqual(state.status, 'error');
    assert.deepStrictEqual(state.problems, ["Step 'Get summaries' reads `transcripts` from 'List meetings', which returns no such field."]);
    assert.strictEqual(state.error, state.problems[0]);

    const fine = await tryStateOf({ item: ITEM, tryId: 'try-1' }, world({ automation, run, steps: [steps[0], { ...steps[1], status: 'success' }] }).deps);
    assert.deepStrictEqual([fine.status, fine.problems], ['success', []]);
});
