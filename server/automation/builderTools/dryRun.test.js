'use strict';

/**
 * builder_request_dry_run in a PREVIEW turn (Approve each change, Plan first, a
 * size-checked build): `draftWrap._stagedDryRun` is set by the route.
 *
 * The rule: the definition in front of the model is a proposal, so running it
 * must not save it. The run takes the saved row only for its identity and
 * executes the STAGED definition in memory; the runner's dry-run mode simulates
 * every side-effect step. A direct build keeps saving first, as before.
 *
 * Every collaborator is injected, so nothing here touches a store or the runner.
 *
 * Run: cd server && node --test automation/builderTools/dryRun.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { applyRequestDryRun } = require('./dryRun');

let executed;
let persisted;
let row;
const deps = () => ({
    persistDraft: async (wrap) => { persisted.push(wrap.automationId); return { id: wrap.automationId || 'new', definition: wrap.def }; },
    getAutomation: async () => row,
    getRunSteps: async () => [{ stepId: 's1', status: 'success', output: { ok: true } }],
    executeAutomation: async (automation, opts) => { executed.push({ automation, opts }); return { id: 'run1', status: 'success' }; },
    annotate: async (s) => ({ outputType: typeof s.output }),
});

const savedDef = () => ({ schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'set', label: 'Saved' }], edges: [{ from: 'trg', to: 's1' }] });
const wrapOf = (extra = {}) => {
    const def = savedDef();
    def.steps[0].label = 'Staged';
    return { userId: 'u1', automationId: 'a1', title: 'T', description: '', def, ...extra };
};

beforeEach(() => {
    executed = [];
    persisted = [];
    row = { id: 'a1', userId: 'u1', title: 'T', version: 3, definition: savedDef() };
});

test('a staged dry run executes the staged definition and saves nothing', async () => {
    const out = await applyRequestDryRun(wrapOf({ _stagedDryRun: true }), {}, deps());
    assert.deepEqual(persisted, [], 'the proposal was not persisted to run it');
    assert.equal(executed.length, 1);
    assert.equal(executed[0].opts.mode, 'dry_run', 'side effects are simulated by the runner');
    assert.equal(executed[0].opts.triggerKind, 'dry_run');
    assert.equal(executed[0].automation.id, 'a1');
    assert.equal(executed[0].automation.definition.steps[0].label, 'Staged', 'the STAGED steps run, not the saved ones');
    assert.equal(row.definition.steps[0].label, 'Saved', 'the saved row is untouched');
    assert.equal(out.run.id, 'run1');
    assert.deepEqual(out.steps[0]._hint, { outputType: 'object' }, 'each step is annotated for the model');
});

test('the staged definition is handed over as a copy: the run cannot edit the proposal', async () => {
    const wrap = wrapOf({ _stagedDryRun: true });
    await applyRequestDryRun(wrap, {}, deps());
    executed[0].automation.definition.steps[0].label = 'Mutated by the run';
    assert.equal(wrap.def.steps[0].label, 'Staged');
});

test('a direct build still saves the draft first and runs the saved row', async () => {
    await applyRequestDryRun(wrapOf(), {}, deps());
    assert.deepEqual(persisted, ['a1']);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].automation.definition.steps[0].label, 'Staged', 'what persistDraft returned');
});

test('a staged dry run of a draft that was never saved says so, and runs nothing', async () => {
    const out = await applyRequestDryRun(wrapOf({ _stagedDryRun: true, automationId: null }), {}, deps());
    assert.match(out.error, /has not been saved yet/);
    assert.match(out.error, /apply the proposal first/);
    assert.equal(executed.length, 0);
    assert.deepEqual(persisted, []);
});

test('a staged dry run refuses a row that is not the caller\'s, or that is gone', async () => {
    row = { ...row, userId: 'someone-else' };
    const other = await applyRequestDryRun(wrapOf({ _stagedDryRun: true }), {}, deps());
    assert.match(other.error, /could not be read/);
    row = null;
    const gone = await applyRequestDryRun(wrapOf({ _stagedDryRun: true }), {}, deps());
    assert.match(gone.error, /could not be read/);
    assert.equal(executed.length, 0);
});

test('an unknown triggerStepId is refused before anything runs, staged or not', async () => {
    for (const _stagedDryRun of [true, false]) {
        const out = await applyRequestDryRun(wrapOf({ _stagedDryRun }), { triggerStepId: 'nope' }, deps());
        assert.match(out.error, /Unknown triggerStepId "nope"/);
    }
    assert.equal(executed.length, 0);
    assert.deepEqual(persisted, []);
});

test('an additional trigger is entered by id; the primary is the default', async () => {
    const wrap = wrapOf({ _stagedDryRun: true });
    wrap.def.triggers = [{ id: 'trg2', type: 'trigger', kind: 'webhook' }];
    await applyRequestDryRun(wrap, { triggerStepId: 'trg2', triggerPayload: { a: 1 } }, deps());
    assert.equal(executed[0].opts.rootStepId, 'trg2');
    assert.deepEqual(executed[0].opts.triggerPayload, { a: 1 });
    await applyRequestDryRun(wrap, { triggerStepId: 'trg' }, deps());
    assert.equal(executed[1].opts.rootStepId, null);
});

test('the watcher hears the run as soon as it exists, and never fails the run', async () => {
    const heard = [];
    const wrap = wrapOf({ _stagedDryRun: true, _onDryRunStarted: (run) => { heard.push(run.id); throw new Error('a broken watcher'); } });
    const d = deps();
    d.executeAutomation = async (_a, opts) => { await opts.onRunCreated({ id: 'run1', status: 'running' }); return { id: 'run1' }; };
    const out = await applyRequestDryRun(wrap, {}, d);
    assert.deepEqual(heard, ['run1']);
    assert.equal(out.run.id, 'run1');
    const quiet = [];
    const d2 = deps();
    d2.executeAutomation = async (_a, opts) => { quiet.push(opts.onRunCreated); return { id: 'run1' }; };
    await applyRequestDryRun(wrapOf({ _stagedDryRun: true }), {}, d2);
    assert.deepEqual(quiet, [null], 'no watcher (MCP): no hook');
});
