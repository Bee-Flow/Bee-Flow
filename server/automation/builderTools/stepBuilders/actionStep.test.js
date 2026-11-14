/**
 * builder_add_action (applyAddAction): the outcomes the builder suites reach
 * only indirectly — no arguments, the datatable redirect both ways, a table id
 * next to a real tool, where the tool name was read from, undeclared inputs and
 * the duplicate guard with its branch exemption.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test automation/builderTools/stepBuilders/actionStep.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAddAction } = require('./actionStep');
const { emptyDefinition } = require('../draftGraph');

const lit = (value) => ({ kind: 'literal', value });
const TOOLS = ['nextcloud_read_file', 'nextcloud_delete'];
const FACTUREN = { id: 'tbl_1a2b3c', key: 'facturen', name: 'Facturen', canWrite: true, columns: [{ key: 'leverancier', name: 'Leverancier', type: 'text' }] };
const NOTE = 'this step names a datatable, so it was built as a `datatable` step — builder_add_action is for integration tools only. Use builder_add_datatable (or type:"datatable" in builder_add_steps) next time.';

function setup(extra = {}) {
    const draft = emptyDefinition();
    draft.steps = [{ id: 'c', type: 'set', fields: { x: lit(1) }, label: 'C' }, { id: 'cond', type: 'condition', expr: 'true', label: 'K' }];
    draft.edges = [{ from: 'trg', to: 'c' }, { from: 'c', to: 'cond' }];
    const schemas = Object.fromEntries(TOOLS.map((t) => [t, { properties: { path: {} }, required: ['path'] }]));
    const wrap = { userId: 'u', def: draft, _inspectedTools: new Set(TOOLS), _availableToolNames: new Set(TOOLS), _inputSchemasByTool: schemas, ...extra };
    return { draft, wrap, add: (args) => applyAddAction(draft, args, wrap) };
}
const action = (tool, inputs, more = {}) => ({ type: 'integration_action', tool, inputs, label: tool, sideEffect: tool === 'nextcloud_delete', ...more });
const withoutId = ({ id, ...rest }) => (assert.match(id, /^a_[0-9a-f]+$/), rest);

test('no arguments: the missing tool is refused with the tools there are', () => {
    const r = setup().add(null);
    assert.equal(r.error, 'builder_add_action needs a `tool` name from the catalog. Write tool:"<exact name>" at the top level of the step, next to inputs. Tools you can use here: nextcloud_read_file, nextcloud_delete.');
    assert.match(r._fixHint, /^Reject reason: the step names no tool\./);
});

test('a datatable step sent here is built as one and says so; its refusal carries the note in the hint', () => {
    const ok = setup({ _datatables: [FACTUREN] }).add({ datatableId: 'tbl_1a2b3c', op: 'find_rows', where: [] });
    assert.equal(ok.added.type, 'datatable');
    assert.deepEqual(ok._warnings, [NOTE]);
    const s = setup({ _datatables: [FACTUREN] });
    const refused = s.add({ inputs: { datatableKey: 'nope', op: 'find_rows' } });
    assert.match(refused.error, /^There is no datatable "nope" available to this user\./);
    assert.ok(refused._fixHint.endsWith(` Note: ${NOTE}`), refused._fixHint);
    assert.equal(s.draft.steps.length, 2);
});

test('a table id next to a real tool stays an integration action', () => {
    const r = setup().add({ tool: 'nextcloud_read_file', datatableId: 'tbl_1a2b3c', inputs: { path: lit('/a') } });
    assert.deepEqual(withoutId(r.added), action('nextcloud_read_file', { path: lit('/a') }));
    assert.equal(r._warnings, undefined);
});

test('a tool name read from the inputs leaves them, with both notes; from the top level only the first', () => {
    const fromInputs = setup().add({ inputs: { toolName: 'nextcloud_read_file', path: lit('/a') } });
    assert.deepEqual(withoutId(fromInputs.added), action('nextcloud_read_file', { path: lit('/a') }));
    assert.deepEqual(fromInputs._warnings, [
        'the tool name was read from "inputs.toolName" — write it as tool:"nextcloud_read_file".',
        'inputs.toolName was removed from the inputs — it carried the tool name, not a value for nextcloud_read_file.',
    ]);
    const fromTop = setup().add({ toolName: 'nextcloud_read_file', inputs: { path: lit('/a') } });
    assert.deepEqual(fromTop._warnings, ['the tool name was read from "toolName" — write it as tool:"nextcloud_read_file".']);
});

test('an input the tool does not declare is kept with a warning; a missing required one is refused', () => {
    const s = setup();
    const r = s.add({ tool: 'nextcloud_delete', label: 'Weg', inputs: { path: lit('/a'), bogus: lit(1) } });
    assert.deepEqual(withoutId(r.added), action('nextcloud_delete', { path: lit('/a'), bogus: lit(1) }, { label: 'Weg' }));
    assert.deepEqual(r._warnings, ['input "bogus" is not declared on nextcloud_delete (declared: path) — it will likely be ignored at runtime']);
    const missing = s.add({ tool: 'nextcloud_read_file', inputs: {} });
    assert.match(missing.error, /^nextcloud_read_file: required input "path" is not bound\. The previous step a_[0-9a-f]+ \(nextcloud_delete\) outputs a top-level "path"/);
    assert.equal(s.draft.steps.length, 3);
});

test('the same call twice on one path is refused; on a branch of a condition it is not', () => {
    const s = setup();
    const first = s.add({ tool: 'nextcloud_read_file', inputs: { path: lit('/a') } });
    const again = s.add({ tool: 'nextcloud_read_file', inputs: { path: lit('/a') } });
    assert.equal(again.error, `This draft already has step "${first.added.id}" calling nextcloud_read_file with identical inputs, and nothing between the two changes anything — adding it again would run the same call twice. Reference "${first.added.id}" downstream (steps.${first.added.id}.output.…) instead. A re-read after a step that writes is allowed: append it after that step (afterStepId).`);
    assert.ok(s.add({ tool: 'nextcloud_read_file', inputs: { path: lit('/a') }, afterStepId: 'cond' }).added);
    assert.ok(s.add({ tool: 'nextcloud_read_file', inputs: { path: lit('/a') }, branch: 'else', afterStepId: 'c' }).added);
    assert.equal(s.draft.steps.length, 5);
});
