/**
 * builder_update_step: the outcome of each pass in applyUpdateStep that the
 * scenario golden (stepEditing.characterisation.test.js) does not reach. Every
 * case goes through the public barrel and pins the result; a refusal also
 * pins that the draft is untouched.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test automation/builderTools/stepEditing/updateStep.branches.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyUpdateStep } = require('../stepEditing');
const { emptyDefinition } = require('../draftGraph');

const lit = (value) => ({ kind: 'literal', value });
const ref = (p) => ({ kind: 'ref', path: p });
const A = { id: 'a', type: 'notification', title: 'Hallo', body: 'Body', channels: ['notification'], label: 'Notify' };
const SET_C = { id: 'c', type: 'set', fields: { x: lit(1), y: lit(2) }, label: 'C' };
const notif = (extra = {}) => ({ id: 'n', type: 'notification', title: 'x', body: '', channels: ['notification'], label: 'N', ...extra });
const http = (url) => ({ id: 'h', type: 'http_request', url, method: 'GET', label: 'H' });
const listSet = (extra = {}) => ({ id: 'st', type: 'set', arrayRef: 'trigger.output.items', fields: { q: lit(1) }, label: 'ST', ...extra });
const aiStep = (extra = {}) => ({ id: 'b', type: 'ai_step', prompt: 'p', label: 'B', ...extra });

function run(steps, stepId, patch, wrapExtra = {}) {
    const def = emptyDefinition();
    def.steps = structuredClone(steps);
    def.edges = [{ from: 'trg', to: steps[0].id }, ...steps.slice(1).map((s, i) => ({ from: steps[i].id, to: s.id }))];
    const before = JSON.stringify(def);
    const result = applyUpdateStep(def, { stepId, patch }, { userId: 'u', def, _inspectedTools: new Set(['nextcloud_move']), ...wrapExtra });
    return { result, untouched: JSON.stringify(def) === before, def };
}

/** A refusal leaves the draft as it was and answers with this exact error. */
function refused(r, error) {
    assert.strictEqual(r.result.error, error);
    assert.ok(r.untouched, 'the draft is untouched after a refusal');
}

test('fill_document: a document that must be read first is refused', () => {
    refused(run([A, { id: 'fd', type: 'fill_document', documentId: 'doc1', values: {}, label: 'FD' }], 'fd', { documentId: 'doc2' }, { _documentDiscoveryRequired: true }),
        'Read builder_read_document({documentId:"doc2"}) before configuring this document.');
});

test('fill_document: a known contract pins the document version on the patch', () => {
    const r = run([A, { id: 'fd', type: 'fill_document', documentId: 'doc1', values: {}, label: 'FD' }], 'fd', { values: {} },
        { _documentContracts: { doc1: { versionId: 'v9', parameters: [], sections: [] } } });
    assert.deepStrictEqual(r.result, { updated: { id: 'fd', type: 'fill_document', documentId: 'doc1', values: {}, label: 'FD', documentVersionId: 'v9' } });
});

test('a step type without an allow-list is refused', () => {
    refused(run([A, { id: 'm', type: 'mystery', label: 'M' }], 'm', { label: 'x' }), 'Step type "mystery" cannot be patched.');
});

test('a loop patched with steps gets the replace-the-body way out', () => {
    const r = run([A, { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'it', maxIterations: 10, body: [], label: 'Loop' }], 'lp', { steps: [] });
    assert.match(r.result.error, /^A loop's body is not patched field-by-field\. .*builder_replace_step\(\{stepId:"lp"/);
    assert.ok(r.untouched);
});

test('integration_action: a new tool merges the patched inputs over the old ones, the label follows only an auto-label', () => {
    const step = { id: 'ia', type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: lit('/a') }, label: 'nextcloud_read_file' };
    const auto = run([A, step], 'ia', { tool: 'nextcloud_move', inputs: { from: lit('/a') } });
    assert.deepStrictEqual(auto.result.updated, { ...step, tool: 'nextcloud_move', inputs: { path: lit('/a'), from: lit('/a') }, label: 'nextcloud_move', sideEffect: true });
    const named = run([A, { ...step, label: 'Read it' }], 'ia', { tool: 'nextcloud_move' });
    assert.deepStrictEqual(named.result.updated, { ...step, tool: 'nextcloud_move', label: 'Read it', sideEffect: true });
});

test('set: operations are replaced through the add sanitiser; empty and null clear them', () => {
    const withOps = listSet({ operations: [{ op: 'sort', key: 'q' }] });
    const { operations, ...without } = withOps;
    assert.ok(operations);
    assert.deepStrictEqual(run([A, withOps], 'st', { operations: [] }).result, { updated: without });
    assert.deepStrictEqual(run([A, withOps], 'st', { operations: null }).result, { updated: without });
    assert.deepStrictEqual(run([A, listSet()], 'st', { operations: [{ op: 'sort', key: 'q' }] }).result, { updated: withOps });
    refused(run([A, listSet()], 'st', { operations: [{ op: 'nope' }] }), 'operations[0]: unknown op "nope". Use one of: rowId, groupId, rename, keep, remove, sort.');
});

test('parse_json: fields are replaced wholesale, a bad list is refused', () => {
    const pj = { id: 'pj', type: 'parse_json', sourceRef: 'steps.a.output.body', mode: 'object', fields: [{ name: 'a', path: 'a' }], label: 'PJ' };
    assert.deepStrictEqual(run([A, pj], 'pj', { fields: [{ name: 'b', path: 'b' }] }).result, { updated: { ...pj, fields: [{ name: 'b', path: 'b' }] } });
    refused(run([A, pj], 'pj', { fields: 'x' }), 'fields must be a non-empty array of { name, path?, description?, fallback? }.');
});

test('forEach: a valid one is stored, a malformed one refused', () => {
    const r = run([A, notif()], 'n', { forEach: { overRef: 'trigger.output.items', itemVar: 'row' }, title: 'Row {{loop.row.name}}' });
    assert.deepStrictEqual(r.result, { updated: notif({ title: 'Row {{loop.row.name}}', forEach: { overRef: 'trigger.output.items', itemVar: 'row' } }) });
    refused(run([A, notif()], 'n', { forEach: 'bad' }), 'forEach must be an object { overRef, itemVar, maxIterations?, concurrency? }, or omitted.');
    refused(run([A, notif({ forEach: { overRef: 'trigger.output.items', itemVar: 'it' } })], 'n', { forEach: {} }),
        'forEach requires `overRef` — a ref to an upstream array, e.g. "steps.<id>.output.results".');
});

test('text fields: a placeholder an authoritative shape cannot find is refused', () => {
    refused(run([A, SET_C, notif()], 'n', { title: 'See {{steps.c.output.zzz}}' }),
        'title: "steps.c.output.zzz" does not resolve: steps.c.output has no "zzz". steps.c.output has: x, y.');
});

test('http_request: url and query together, the query alone, a query left in the url', () => {
    assert.deepStrictEqual(run([A, http('https://api.example.com/x')], 'h', { url: 'https://api.example.com/p?z=2', query: { a: '1' } }).result,
        { updated: { ...http('https://api.example.com/p?z=2'), query: { mode: 'json', json: '{"a":"1"}' } } });
    assert.deepStrictEqual(run([A, http('https://api.example.com/x?z=1')], 'h', { query: { a: '1' } }).result,
        { updated: { ...http('https://api.example.com/x?z=1'), query: { mode: 'json', json: '{"a":"1"}' } } });
    assert.deepStrictEqual(run([A, http('https://api.example.com/x?z=1')], 'h', { query: null }).result, { updated: http('https://api.example.com/x?z=1') });
    assert.deepStrictEqual(run([A, http('https://api.example.com/x')], 'h', { url: 'https://api.example.com/y?q=1' }).result, { updated: http('https://api.example.com/y?q=1') });
    assert.deepStrictEqual(run([A, http('https://api.example.com/x?z=1')], 'h', { url: 5 }).result, { updated: { ...http('https://api.example.com/x?z=1'), url: 5 } });
    refused(run([A, SET_C, http('https://api.example.com/x')], 'h', { query: { a: '{{steps.c.output.zzz}}' } }),
        'query.json: "steps.c.output.zzz" does not resolve: steps.c.output has no "zzz". steps.c.output has: x, y.');
});

test('list refs: arrayRef and a loop overRef are checked, with the message in the field\'s own name', () => {
    refused(run([A, SET_C, { id: 'li', type: 'limit', arrayRef: 'trigger.output.items', count: 1, label: 'L' }], 'li', { arrayRef: 'steps.c.output.zzz' }),
        'arrayRef: "steps.c.output.zzz" does not resolve: steps.c.output has no "zzz". steps.c.output has: x, y.');
    const loop = { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'it', maxIterations: 10, body: [], label: 'Loop' };
    refused(run([A, SET_C, loop], 'lp', { overRef: 'steps.c.output.zzz' }),
        'overRef: "steps.c.output.zzz" does not resolve: steps.c.output has no "zzz". steps.c.output has: x, y.');
    const noted = run([A, loop], 'lp', { overRef: 'a.output.items' });
    assert.deepStrictEqual(noted.result.updated, { ...loop, overRef: 'a.output.items' });
    assert.match(noted.result._warnings[0], /^overRef: ref path "a\.output\.items" has unknown root "a"\./);
    // A set step's list is checked with a strict root: the same miss is a refusal there.
    refused(run([A, listSet()], 'st', { arrayRef: 'output.items' }),
        'arrayRef: ref path "output.items" has unknown root "output". Valid roots: trigger, steps, vars, secrets, loop. Use e.g. trigger.output.<field> or steps.<id>.output.<field>.');
});

test('datatable: the cursor is stored as a binding, a cursor that does not resolve is refused', () => {
    const dt = { id: 'dt', type: 'datatable', op: 'find_rows', datatableId: 'tbl_1a2b3c', where: [], label: 'F' };
    const r = run([A, dt], 'dt', { cursor: '{{steps.a.output.title}}' });
    assert.deepStrictEqual(r.result.updated, { ...dt, cursor: ref('steps.a.output.title') });
    assert.strictEqual(r.result._warnings.length, 1);
    assert.deepStrictEqual(run([A, dt], 'dt', { cursor: 5 }).result, { updated: { ...dt, cursor: lit(5) } });
    refused(run([A, SET_C, dt], 'dt', { cursor: '{{steps.c.output.zzz}}' }),
        'inputs.cursor: "steps.c.output.zzz" does not resolve: steps.c.output has no "zzz". steps.c.output has: x, y.');
});

test('flatten: the plan is rebuilt from the checked arrayRef; a list without children is refused', () => {
    const fl = { id: 'fl', type: 'flatten', arrayRef: 'trigger.output.items', parents: [], childField: 'kids', label: 'FL' };
    assert.deepStrictEqual(run([A, fl], 'fl', { arrayRef: 'trigger.output.rows', childField: 'kids' }).result,
        { updated: { ...fl, arrayRef: 'trigger.output.rows[*].kids', parents: [{ overRef: 'trigger.output.rows', itemVar: 'row', auto: true }] } });
    refused(run([A, fl], 'fl', { arrayRef: 'trigger.output.rows' }),
        'flatten op: trigger.output.rows has no list inside each item to make rows from. Pass childField, the name of the list inside each item (e.g. "attachments").');
});

test('code: the hash follows the code, also when it is emptied', () => {
    assert.deepStrictEqual(run([A, { id: 'k', type: 'code', code: 'return 1', label: 'K' }], 'k', { code: '' }).result,
        { updated: { id: 'k', type: 'code', code: '', label: 'K', codeHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } });
});

test('ai_step: the agent block after the patch lands', () => {
    const kept = run([A, aiStep({ agentId: 'agent_1', disabledAgentSkillIds: ['s2'] })], 'b', { prompt: 'q' });
    assert.deepStrictEqual(kept.result, { updated: { ...aiStep({ agentId: 'agent_1', disabledAgentSkillIds: ['s2'] }), prompt: 'q', agentPermissions: { startAutomations: false, useKnowledge: false, useTools: false } } });
    const dropped = run([A, aiStep({ disabledAgentSkillIds: ['s2'] })], 'b', { prompt: 'q' });
    assert.deepStrictEqual(dropped.result, { updated: { ...aiStep(), prompt: 'q' } });
    // Permissions without an agent are refused, but the step slot was already
    // written: that order is pinned here.
    const r = run([A, aiStep()], 'b', { agentPermissions: { useTools: true } });
    assert.match(r.result.error, /^agentPermissions "useTools" was set but the step names no agent/);
    assert.ok(r.result._fixHint);
    assert.strictEqual(r.untouched, false);
    assert.deepStrictEqual(r.def.steps[1].agentPermissions, { startAutomations: false, useKnowledge: false, useTools: true });
});

test('a datatable patch with the add path\'s vocabulary that still lacks an op is refused with its hint', () => {
    const r = run([A, { id: 'dt', type: 'datatable', op: 'add_row', datatableId: 'tbl_1a2b3c', values: {}, label: 'R' }], 'dt', { op: '' });
    assert.match(r.result.error, /^op is required — this step carries values/);
    assert.strictEqual(r.result._fixHint, 'Reject reason: op missing on a datatable write. Add op and resend — nothing else was checked yet.');
    assert.ok(r.untouched);
});
