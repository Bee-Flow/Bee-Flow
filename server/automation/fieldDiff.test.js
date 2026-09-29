/**
 * automation/fieldDiff.js — the per-field version diff and its plain-language
 * description (Studio → Automations handoff 5, artboard 5d), on fixtures.
 *
 * Run: cd server && node --test automation/fieldDiff.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    fieldDiff, describeChange, describeVersion, describeText, isLayoutOnlyChange, stepIdsOf, stepNumbers, toolLabel, stripLayout,
} = require('./fieldDiff');

const clone = (x) => JSON.parse(JSON.stringify(x));

// Start → Read invoice → Summarise, the shape of the 5d artboard.
const BASE = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start', position: { x: 0, y: 0 } },
    steps: [
        {
            id: 'read', type: 'integration_action', tool: 'nextcloud_list_files', label: 'Read invoice',
            inputs: { folder: { kind: 'literal', value: '/Invoices' } }, position: { x: 300, y: 0 },
        },
        { id: 'sum', type: 'ai_step', prompt: 'Summarise {{steps.read.output.files}}', modelTier: 'fast', position: { x: 600, y: 0 } },
    ],
    edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'sum' }],
};

test('layout only: positions, sizes, colours, icons and PII line colours are not a change', () => {
    const next = clone(BASE);
    next.trigger.position = { x: 10, y: 10 };
    next.steps[0].position = { x: 999, y: 5 };
    next.steps[1].icon = 'sparkles';
    next.steps[1].iconManual = true;
    next.steps.push({ id: 'n1', type: 'note', text: 'hi', position: { x: 1, y: 1 } });
    const withNote = clone(next);
    withNote.steps[2].size = { width: 300, height: 200 };
    withNote.steps[2].color = 'yellow';
    withNote.edges[0].color = 'blue';
    withNote.piiLineColors = { contact: 'red' };
    assert.strictEqual(isLayoutOnlyChange(BASE, clone(BASE)), true, 'identical is layout only');
    assert.strictEqual(isLayoutOnlyChange(next, withNote), true);
    const d = describeVersion(next, withNote);
    assert.deepStrictEqual(d, { layoutOnly: true, changes: [], entries: [], text: null });
    // Moving a node alone.
    const moved = clone(BASE);
    moved.steps[1].position = { x: 5, y: 500 };
    assert.strictEqual(describeVersion(BASE, moved).layoutOnly, true);
    // stripLayout never mutates its input.
    stripLayout(withNote);
    assert.deepStrictEqual(withNote.steps[2].size, { width: 300, height: 200 });
});

test('a changed folder is one row with a readable before/after, and "Folder changed in ..."', () => {
    const next = clone(BASE);
    next.steps[0].inputs.folder = { kind: 'literal', value: '/Invoices/2026' };
    next.steps[0].position = { x: 1, y: 1 }; // rides along, never reported
    const changes = fieldDiff(BASE, next);
    assert.deepStrictEqual(changes, [{
        stepId: 'read', stepNumber: 2, stepLabel: 'Read invoice', change: 'changed',
        setting: 'folder', settingLabel: 'Folder', path: 'inputs.folder', before: '/Invoices', after: '/Invoices/2026',
    }]);
    const d = describeChange(changes);
    assert.deepStrictEqual(d.entries, [{ code: 'setting_changed', params: { setting: 'Folder', settingKey: 'folder', step: 'Read invoice' } }]);
    assert.strictEqual(d.text, 'Folder changed in "Read invoice"');
});

test('an added step: the kind of step as "after", step_added, and it counts in stepIds.added', () => {
    const next = clone(BASE);
    next.steps.push({ id: 'talk', type: 'integration_action', tool: 'talk_send_message', label: 'Message in Talk' });
    next.edges.push({ from: 'sum', to: 'talk' });
    const changes = fieldDiff(BASE, next);
    assert.deepStrictEqual(changes, [{
        stepId: 'talk', stepNumber: 4, stepLabel: 'Message in Talk', change: 'added',
        setting: null, settingLabel: null, path: null, before: null, after: 'Talk · Send message',
    }]);
    assert.deepStrictEqual(stepIdsOf(changes), { added: ['talk'], removed: [], changed: [] });
    assert.deepStrictEqual(describeChange(changes).entries, [{ code: 'step_added', params: { step: 'Message in Talk' } }]);
});

test('a removed step, and the step after it "moved": connections changed', () => {
    const next = clone(BASE);
    next.steps = next.steps.filter((s) => s.id !== 'read');
    next.edges = [{ from: 'trg', to: 'sum' }];
    const changes = fieldDiff(BASE, next);
    const removed = changes.find((c) => c.change === 'removed');
    assert.strictEqual(removed.stepId, 'read');
    assert.strictEqual(removed.before, 'Nextcloud · List files');
    const moved = changes.find((c) => c.change === 'moved');
    assert.strictEqual(moved.stepId, 'sum');
    assert.strictEqual(moved.settingLabel, 'Position in the flow');
    assert.strictEqual(moved.before, 'after Read invoice');
    assert.strictEqual(moved.after, 'after Start');
    // The ref to the removed step reads with its old name on the "was" side.
    const d = describeChange(changes);
    assert.deepStrictEqual(d.entries.map((e) => e.code), ['step_removed', 'connections_changed']);
    assert.strictEqual(d.text, 'Step removed: "Read invoice" and 1 more');
    assert.deepStrictEqual(stepIdsOf(changes), { added: [], removed: ['read'], changed: ['sum'] });
});

test('a rename is step_renamed; several settings on one step are step_changed with a count', () => {
    const renamed = clone(BASE);
    renamed.steps[1].label = 'Summarise invoices';
    const r = describeChange(fieldDiff(BASE, renamed));
    assert.deepStrictEqual(r.entries, [{ code: 'step_renamed', params: { step: 'Summarise invoices', from: null } }]);

    const many = clone(BASE);
    many.steps[1].prompt = 'Something else';
    many.steps[1].modelTier = 'thinking';
    const changes = fieldDiff(BASE, many);
    assert.deepStrictEqual(changes.map((c) => [c.setting, c.settingLabel, c.before, c.after]), [
        ['prompt', 'Instruction', 'Summarise ‹Read invoice › files›', 'Something else'],
        ['modelTier', 'Model', 'fast', 'thinking'],
    ]);
    assert.deepStrictEqual(describeChange(changes).entries, [{ code: 'step_changed', params: { step: 'AI step', count: 2 } }]);
});

test('reordering steps[] alone is "Steps reordered" (works the same), not layout and not a field change', () => {
    const next = clone(BASE);
    next.steps.reverse();
    assert.strictEqual(isLayoutOnlyChange(BASE, next), false);
    const d = describeVersion(BASE, next);
    assert.strictEqual(d.layoutOnly, false);
    assert.deepStrictEqual(d.changes, []);
    assert.deepStrictEqual(d.entries, [{ code: 'steps_reordered', params: {} }]);
    assert.strictEqual(d.text, 'Steps reordered');
});

test('the trigger: a new schedule is trigger_changed with the cron readable', () => {
    const prev = clone(BASE);
    prev.trigger = { id: 'trg', type: 'trigger', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } };
    const next = clone(prev);
    next.trigger.schedule.cron = '0 8 * * 1-5';
    const changes = fieldDiff(prev, next);
    assert.deepStrictEqual(changes.map((c) => [c.stepId, c.stepNumber, c.setting, c.before, c.after, c.isTrigger]), [
        ['trg', 1, 'cron', '0 7 * * 1-5', '0 8 * * 1-5', true],
    ]);
    assert.deepStrictEqual(describeChange(changes).entries, [{ code: 'trigger_changed', params: { step: 'On a schedule' } }]);
});

test('routine settings and the description sit outside the steps', () => {
    const next = clone(BASE);
    next.runPolicy = { retry: { max: 2, then: 'stop_notify' } };
    next.description = 'Reads invoices.';
    const changes = fieldDiff(BASE, next);
    assert.ok(changes.every((c) => c.stepId === null && c.stepLabel === 'Routine'));
    assert.deepStrictEqual(changes.map((c) => c.path).sort(), ['description', 'runPolicy.retry.max', 'runPolicy.retry.then']);
    const d = describeChange(changes);
    assert.deepStrictEqual(d.entries, [
        { code: 'settings_changed', params: { setting: 'Run settings', settingKey: 'runPolicy' } },
        { code: 'description_changed', params: {} },
    ]);
});

test('an agent id reads as the agent name when the caller knows it; a tool as its app and action', () => {
    const prev = clone(BASE);
    prev.steps[1].agentId = 'ag-1';
    const next = clone(prev);
    next.steps[1].agentId = 'ag-2';
    const names = { agent: { 'ag-1': 'Quote assistant', 'ag-2': 'Invoice checker' } };
    const [c] = fieldDiff(prev, next, { names });
    assert.deepStrictEqual([c.setting, c.settingLabel, c.before, c.after], ['agentId', 'Agent', 'Quote assistant', 'Invoice checker']);
    assert.strictEqual(fieldDiff(prev, next)[0].after, 'ag-2', 'without names the id stays');
    assert.strictEqual(toolLabel('nextcloud_upload_file'), 'Nextcloud · Upload file');
    assert.strictEqual(toolLabel('weird_tool_name'), 'Weird tool name');
});

test('long values are cut, lists are joined, booleans read on/off, bindings name their step', () => {
    const prev = clone(BASE);
    const next = clone(BASE);
    next.steps[1].prompt = 'x'.repeat(400);
    next.steps[1].channels = ['bell', 'email'];
    next.steps[1].stopOnError = true;
    const byPath = Object.fromEntries(fieldDiff(prev, next).map((c) => [c.path, c]));
    assert.strictEqual(byPath.prompt.after.length, 140);
    assert.ok(byPath.prompt.after.endsWith('…'));
    assert.strictEqual(byPath.channels.after, 'bell, email');
    assert.strictEqual(byPath.stopOnError.after, 'on');
    assert.strictEqual(byPath.stopOnError.before, null);

    const refNext = clone(BASE);
    refNext.steps[1].inputs = { text: { kind: 'ref', path: 'steps.read.output.files.0.name' } };
    const [ref] = fieldDiff(BASE, refNext);
    assert.strictEqual(ref.after, 'Read invoice › files.0.name');
    assert.strictEqual(ref.setting, 'text');
});

test('steps inside a loop and inside a flowlet are compared as their own rows', () => {
    const prev = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'each', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', body: [{ id: 'inner', type: 'ai_step', prompt: 'a' }] }],
        edges: [{ from: 'trg', to: 'each' }],
        layers: { fl: { title: 'Check', trigger: { id: 'li', kind: 'layer_input' }, steps: [{ id: 'x', type: 'code', code: '1', label: 'Calc' }], edges: [] } },
    };
    const next = clone(prev);
    next.steps[0].body[0].prompt = 'b';
    next.layers.fl.steps[0].code = '2';
    const changes = fieldDiff(prev, next);
    const inner = changes.find((c) => c.stepId === 'inner');
    assert.strictEqual(inner.stepNumber, null, 'nested steps carry no canvas number');
    assert.strictEqual(inner.before, 'a');
    const flow = changes.find((c) => c.stepId === 'x');
    assert.strictEqual(flow.layer, 'fl');
    assert.strictEqual(flow.stepLabel, 'Check › Calc');
    assert.ok(!changes.some((c) => c.stepId === 'each'), 'the loop itself did not change');
});

test('step numbers follow run order and skip notes', () => {
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [{ id: 'b', type: 'code' }, { id: 'note', type: 'note' }, { id: 'a', type: 'code' }],
        edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }],
    };
    assert.deepStrictEqual([...stepNumbers(def).entries()], [['t', 1], ['a', 2], ['b', 3]]);
});

test('describeText renders codes the callers bring (restore, template, copy)', () => {
    assert.strictEqual(describeText([{ code: 'restored', params: { version: 3 } }]), 'Restored from v3');
    assert.strictEqual(describeText([{ code: 'created_from_template', params: { template: 'Invoice inbox' } }]), 'Created from template "Invoice inbox"');
    assert.strictEqual(describeText([{ code: 'duplicated_from', params: { title: 'Invoices' } }]), 'Copied from "Invoices"');
    assert.strictEqual(describeText([{ code: 'unknown' }]), null);
});

test('garbage in: nulls and non-objects never throw', () => {
    assert.deepStrictEqual(fieldDiff(null, undefined), []);
    assert.strictEqual(isLayoutOnlyChange(null, {}), true);
    assert.doesNotThrow(() => describeVersion({ steps: 'nope', edges: 5 }, { steps: [null, 3, { id: 'a', type: 'code' }] }));
});
