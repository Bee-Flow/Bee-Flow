/**
 * The golden behaviour of builder_update_step(s), builder_replace_step and
 * builder_remove_step, pinned before stepEditing.js was split into the
 * stepEditing/ modules behind the `stepEditing` barrel.
 *
 * Each scenario builds a small draft by hand, calls the real export, and
 * records the result AND the graph afterwards (steps, edges). A pure move
 * must leave every recorded value byte-identical. The patch object a
 * scenario sends is recorded too: a few paths mutate it, and that is pinned.
 *
 * Refresh (only for a deliberate behaviour change):
 *   cd server && UPDATE_GOLDEN=1 node --test automation/builderTools/stepEditing.characterisation.test.js
 * Run: cd server && node --test automation/builderTools/stepEditing.characterisation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const stepEditing = require('./stepEditing');
const { emptyDefinition } = require('./draftGraph');

const GOLDEN_PATH = path.join(__dirname, 'stepEditing.characterisation.golden.json');
const lit = (value) => ({ kind: 'literal', value });
const ref = (p) => ({ kind: 'ref', path: p });

const FACTUREN = {
    id: 'tbl_1a2b3c', key: 'facturen', name: 'Facturen', canWrite: true, managedKind: null,
    columns: [{ key: 'leverancier', name: 'Leverancier', type: 'text' }, { key: 'totaal', name: 'Totaal', type: 'number' }],
};
const ALLEEN_LEZEN = { ...FACTUREN, id: 'tbl_ro', key: 'readonly', name: 'Alleen lezen', canWrite: false };

/** trg → a (notification) → b (ai_step reads a) → c (set reads b) → cond (condition) → d / e. */
function base(extraSteps = [], extraEdges = []) {
    const def = emptyDefinition();
    def.steps = [
        { id: 'a', type: 'notification', title: 'Hallo', body: 'Body', channels: ['notification'], label: 'Notify' },
        { id: 'b', type: 'ai_step', prompt: 'Summarise {{steps.a.output.title}}', systemPrompt: null, inputs: { text: ref('steps.a.output.body') }, outputSchema: null, modelTier: 'auto', allowTools: false, tools: null, knowledgeBaseIds: [], useMemory: false, label: 'Think' },
        { id: 'c', type: 'set', fields: { x: ref('steps.b.output.text'), y: lit(1) }, label: 'Set' },
        { id: 'cond', type: 'condition', expr: 'steps.c.output.y == 1', label: 'Check' },
        { id: 'd', type: 'notification', title: 'Then', body: '', channels: ['notification'], label: 'D' },
        { id: 'e', type: 'notification', title: 'Else', body: '', channels: ['notification'], label: 'E' },
        ...extraSteps,
    ];
    def.edges = [
        { from: 'trg', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'cond' },
        { from: 'cond', to: 'd', label: 'then' }, { from: 'cond', to: 'e', label: 'else' },
        ...extraEdges,
    ];
    return def;
}
const wrapOf = (def, extra = {}) => ({ userId: 'u_test', def, _inspectedTools: new Set(), ...extra });

const withSteps = (steps, edges) => {
    const def = emptyDefinition();
    def.steps = steps;
    def.edges = edges || [{ from: 'trg', to: steps[0].id }, ...steps.slice(1).map((s, i) => ({ from: steps[i].id, to: s.id }))];
    return def;
};

const U = (stepId, patch, more = {}) => ({ fn: 'applyUpdateStep', args: { stepId, patch, ...more } });

// Each scenario: [name, () => def, call, wrapExtra]
const SCENARIOS = [
    ['update: no stepId', base, { fn: 'applyUpdateStep', args: { patch: {} } }],
    ['update: patch not an object', base, { fn: 'applyUpdateStep', args: { stepId: 'a', patch: [] } }],
    ['update: id in patch', base, U('a', { id: 'z' })],
    ['update: unknown step', base, U('zz', { label: 'x' })],
    ['update: notification title/body/channels/label', base, U('a', { title: 'Nieuw {{steps.trg.output.x}}', body: 'b2', channels: null, label: '  ' })],
    ['update: notification forEach + null forEach', base, U('d', { forEach: null, label: 'D2' })],
    ['update: not patchable field', base, U('a', { prompt: 'x' })],
    ['update: same type restated', base, U('a', { type: 'notification', title: 'T' })],
    ['update: invalid type change', base, U('a', { type: 'bogus_type' })],
    ['update: type change notification → ai_step', base, U('a', { type: 'ai_step', prompt: 'Hello', label: 'Now AI' })],
    ['update: ai_step scalar fields', base, U('b', { systemPrompt: '  be brief  ', modelTier: '', allowTools: 1, tools: ['x', 3], knowledgeBaseIds: ['k1', '', 7], outputSchema: undefined })],
    ['update: ai_step modelTier gate', base, U('b', { modelTier: 'premium' }), { _allowedModelTiers: new Set(['auto', 'fast']) }],
    ['update: ai_step inputs merge with null delete', base, U('b', { inputs: { text: null, extra: ref('steps.a.output.title') } })],
    ['update: ai_step inputs replace mode', base, U('b', { inputs: { only: lit('x') } }, { inputsMode: 'replace' })],
    ['update: ai_step agent fill and re-point', () => base([{ id: 'ag', type: 'ai_step', prompt: 'p', agentId: 'agent_1', label: 'Ag' }], [{ from: 'e', to: 'ag' }]), U('ag', { agentId: 'agent_2' })],
    ['update: ai_step agentPermissions without agent', base, U('b', { agentPermissions: { useTools: true }, skillIds: ['s1'], disabledAgentSkillIds: ['s2'] })],
    ['update: set fields merge', base, U('c', { fields: { y: null, z: lit('zz') } })],
    ['update: set operations need arrayRef', base, U('c', { operations: [{ op: 'sort', field: 'x' }] })],
    ['update: set list mode + forEach refused', base, U('c', { arrayRef: '', forEach: { overRef: 'steps.a.output.items', itemVar: 'it' } })],
    ['update: set maxItems dropped outside list mode', base, U('c', { maxItems: 5 })],
    ['update: condition expr', base, U('cond', { expr: 'steps.c.output.y == 2' })],
    ['update: move afterStepId', base, U('c', { afterStepId: 'a' })],
    ['update: branch without afterStepId', base, U('c', { branch: 'else' })],
    ['update: elseStepId on non-condition', base, U('c', { elseStepId: 'd' })],
    ['update: elseStepId on condition', base, U('cond', { elseStepId: 'd' })],
    ['update: thenStepId empty', base, U('cond', { thenStepId: '' })],
    ['update: move plus label', base, U('e', { afterStepId: 'a', label: 'Moved' })],
    ['update: http_request scalars', () => withSteps([{ id: 'h', type: 'http_request', url: 'https://api.example.com/x', method: 'GET', headers: {}, body: '', timeoutMs: 10000, blockPrivateTargets: true, parseResponse: 'auto', label: 'Call' }]),
        U('h', { method: 'post', headers: [], body: 5, timeoutMs: 999999, blockPrivateTargets: 'no', parseResponse: 'sometimes', askOnce: { ttl: 3, scope: 'x' }, cacheInto: { enabled: true } })],
    ['update: http_request url with query lifted', () => withSteps([{ id: 'h', type: 'http_request', url: 'https://api.example.com/x', method: 'GET', label: 'Call' }]),
        U('h', { url: 'https://api.example.com/y?q=1&r={{trigger.output.x}}' })],
    ['update: http_request query only', () => withSteps([{ id: 'h', type: 'http_request', url: 'https://api.example.com/x', method: 'GET', label: 'Call' }]),
        U('h', { query: { a: '1', b: ['x', 'y'] } })],
    ['update: http_request bad placeholder', () => withSteps([{ id: 'h', type: 'http_request', url: 'https://api.example.com/x', method: 'GET', label: 'Call' }]),
        U('h', { body: '{{steps.nope.output.x}}' })],
    ['update: code fields', () => withSteps([{ id: 'k', type: 'code', code: 'return 1', inputs: {}, outputSchema: null, allowedTools: [], label: 'Code' }]),
        U('k', { code: 'return 2', allowedTools: 'x', limits: { memoryMb: 64 }, outputSchema: { type: 'object' } })],
    ['update: code bad limits passed through', () => withSteps([{ id: 'k', type: 'code', code: 'return 1', label: 'Code' }]), U('k', { limits: { memoryMb: 'lots' } })],
    ['update: integration_action tool change unknown', () => withSteps([{ id: 'ia', type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: lit('/a') }, label: 'nextcloud_read_file' }]),
        U('ia', { tool: 'nope tool' })],
    ['update: integration_action tool change ok', () => withSteps([{ id: 'ia', type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: lit('/a') }, label: 'nextcloud_read_file' }]),
        U('ia', { tool: 'nextcloud_delete', askOnce: true }), { _availableToolNames: new Set(['nextcloud_read_file', 'nextcloud_delete']) }],
    ['update: integration_action inspect gate', () => withSteps([{ id: 'ia', type: 'integration_action', tool: 'nextcloud_read_file', inputs: {}, label: 'R' }]),
        U('ia', { tool: 'nextcloud_move' }), { _inputSchemasByTool: { nextcloud_move: { properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } }],
    ['update: integration_action tool:"datatable" type change', () => withSteps([{ id: 'nc', type: 'integration_action', tool: 'nextcloud_tables_create_row', inputs: { tableId: lit('Facturen'), values: { Leverancier: lit('ACME') } }, label: 'Save' }]),
        U('nc', { tool: 'datatable', datatableId: 'tbl_1a2b3c' }), { _datatables: [FACTUREN] }],
    ['update: datatable values with title keys', () => withSteps([{ id: 'dt', type: 'datatable', op: 'add_row', datatableId: 'tbl_1a2b3c', datatableKey: 'facturen', values: { leverancier: lit('A'), totaal: lit(1) }, label: 'Row' }]),
        U('dt', { values: { Totaal: lit(5), leverancier: null } }), { _datatables: [FACTUREN] }],
    ['update: datatable re-point refused', () => withSteps([{ id: 'dt', type: 'datatable', op: 'add_row', datatableId: 'tbl_1a2b3c', values: {}, label: 'Row' }]),
        U('dt', { datatableId: 'tbl_other' })],
    ['update: datatable same table no-op', () => withSteps([{ id: 'dt', type: 'datatable', op: 'add_row', datatableId: 'tbl_1a2b3c', values: {}, label: 'Row' }]),
        U('dt', { datatableId: 'Facturen' }), { _datatables: [FACTUREN] }],
    ['update: datatable fill blank id', () => withSteps([{ id: 'dt', type: 'datatable', op: 'find_rows', datatableId: '', where: [], label: 'Find' }]),
        U('dt', { datatableKey: 'facturen', where: [{ column: 'Leverancier', op: 'eq', value: lit('x') }], sort: { column: 'Totaal', dir: 'desc' } }), { _datatables: [FACTUREN] }],
    ['update: datatable write on read-only', () => withSteps([{ id: 'dt', type: 'datatable', op: 'find_rows', datatableId: 'tbl_ro', where: [], label: 'Find' }]),
        U('dt', { op: 'add_row' }), { _datatables: [ALLEEN_LEZEN] }],
    ['update: datatable foreign vocabulary', () => withSteps([{ id: 'dt', type: 'datatable', op: 'add_row', datatableId: 'tbl_1a2b3c', values: {}, label: 'Row' }]),
        U('dt', { row: { leverancier: lit('B') }, op: 'append' }), { _datatables: [FACTUREN] }],
    ['update: data_extraction fields/instructions/source', () => withSteps([{ id: 'src', type: 'notification', title: 't', body: '', channels: ['notification'], label: 'Src' }, { id: 'de', type: 'data_extraction', source: ref('steps.src.output.body'), fields: [{ name: 'a', type: 'string' }], label: 'Ex' }]),
        U('de', { fields: [{ name: 'total', type: 'number', description: 'sum', required: true }], instructions: '  read it  ', source: ref('steps.src.output.title') })],
    ['update: data_extraction foreign vocabulary', () => withSteps([{ id: 'src', type: 'notification', title: 't', body: '', channels: ['notification'], label: 'Src' }, { id: 'de', type: 'data_extraction', source: ref('steps.src.output.body'), fields: [{ name: 'a', type: 'string' }], label: 'Ex' }]),
        U('de', { inputs: { source: ref('steps.src.output.title') }, prompt: 'Find totals' })],
    ['update: loop body refusal', () => withSteps([{ id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'it', maxIterations: 10, body: [{ id: 'lb', type: 'notification', title: 'x', body: '', channels: ['notification'] }], label: 'Loop' }]),
        U('lp', { body: [] })],
    ['update: loop scalars', () => withSteps([{ id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'it', maxIterations: 10, body: [{ id: 'lb', type: 'notification', title: 'x', body: '', channels: ['notification'] }], label: 'Loop' }]),
        U('lp', { maxIterations: 0, itemVar: 'row' })],
    ['update: loop-body step patch', () => withSteps([{ id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'it', maxIterations: 10, body: [{ id: 'lb', type: 'notification', title: 'x', body: '', channels: ['notification'] }], label: 'Loop' }]),
        U('lb', { title: 'item {{loop.it}}' })],
    ['update: loop-body type change refused', () => withSteps([{ id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'it', maxIterations: 10, body: [{ id: 'lb', type: 'notification', title: 'x', body: '', channels: ['notification'] }], label: 'Loop' }]),
        U('lb', { type: 'ai_step', prompt: 'p' })],
    ['update: misc scalars (wait, limit, dedupe, form_page)', () => withSteps([
        { id: 'w', type: 'wait', seconds: 5, label: 'W' }, { id: 'l', type: 'limit', arrayRef: 'trigger.output.items', count: 1, mode: 'first', label: 'L' },
        { id: 'dd', type: 'dedupe', arrayRef: 'trigger.output.items', keyField: 'id', label: 'DD' }, { id: 'fp', type: 'form_page', mode: 'input', form: {}, waitSeconds: 3600, label: 'FP' }]),
    { fn: 'applyUpdateSteps', args: { updates: [{ stepId: 'w', patch: { seconds: 999999 } }, { stepId: 'l', patch: { count: '3.7', mode: 'x' } }, { stepId: 'dd', patch: { keyField: 4 } }, { stepId: 'fp', patch: { mode: 'ending', form: [], waitSeconds: 1 } }] } }],
    ['update: note, guard, knowledge_write', () => withSteps([
        { id: 'n', type: 'note', text: 'hi', label: 'N' }, { id: 'g', type: 'guard', sourceRef: 'trigger.output.x', label: 'G' },
        { id: 'kw', type: 'knowledge_write', knowledgeBaseId: 'kb1', content: '', label: 'KW' }]),
    { fn: 'applyUpdateSteps', args: { updates: [
        { stepId: 'n', patch: { text: 'x'.repeat(5), position: { x: '1', y: 2 }, color: 'nope', size: { w: 1 } } },
        { stepId: 'g', patch: { sourceRef: ' trigger.output.y ', categories: ['EMAIL', '', 3], confidence: 2, onFound: { stop: true, mask: 'yes', bogus: 1 } } },
        { stepId: 'kw', patch: { content: ref('trigger.output.x'), title: 'T', nearDuplicateStrategy: 'skip' } }] } }],
    ['update: knowledge_write re-point refused', () => withSteps([{ id: 'kw', type: 'knowledge_write', knowledgeBaseId: 'kb1', content: '', label: 'KW' }]), U('kw', { knowledgeBaseId: 'kb2' })],
    ['update: generate_document, slide, presentation', () => withSteps([
        { id: 'gd', type: 'generate_document', content: 'x', format: 'pdf', label: 'GD' }, { id: 'sl', type: 'slide', title: 'S', label: 'SL' },
        { id: 'pr', type: 'presentation', title: 'P', slides: '', label: 'PR' }]),
    { fn: 'applyUpdateSteps', args: { updates: [
        { stepId: 'gd', patch: { format: 'docx', contentFormat: 'x', expiresInDays: 'abc', title: 5 } },
        { stepId: 'sl', patch: { layout: 'nope', notes: 3, image: '  ' } },
        { stepId: 'pr', patch: { format: 'pdf', houseStyle: 0, logo: 'Geen', slides: ref('steps.sl.output.slide'), subtitle: null } }] } }],
    ['update: switch cases', () => withSteps([{ id: 'sw', type: 'switch', expr: 'trigger.output.k', cases: [{ name: 'a', value: 'a' }], defaultBranch: null, label: 'SW' }]),
        U('sw', { cases: [{ name: 'a', value: 'a' }, { name: 'b', expr: 'trigger.output.k == "b"' }], defaultBranch: 5, matchMode: 'any', maxItems: -1 })],
    ['update: datetime', () => withSteps([{ id: 'dtm', type: 'datetime', op: 'now', label: 'DT' }]),
        U('dtm', { input: 3, format: 'yyyy', amount: '2', arrayRef: '' })],
    ['updates: unchanged', base, { fn: 'applyUpdateSteps', args: { updates: [{ stepId: 'a', patch: { title: 'Hallo' } }] } }],
    ['updates: rollback on error', base, { fn: 'applyUpdateSteps', args: { updates: [{ stepId: 'a', patch: { title: 'changed' } }, { stepId: 'b', patch: { bogus: 1 } }] } }],
    ['updates: empty', base, { fn: 'applyUpdateSteps', args: { updates: [] } }],
    ['updates: mixed changed/unchanged with move', base, { fn: 'applyUpdateSteps', args: { updates: [{ stepId: 'a', patch: { title: 'Hallo' } }, { stepId: 'e', patch: { afterStepId: 'a' } }] } }],
    ['replace: no stepId', base, { fn: 'applyReplaceStep', args: { newType: 'notification', spec: {} } }],
    ['replace: parse_json retired', base, { fn: 'applyReplaceStep', args: { stepId: 'a', newType: 'parse_json', spec: {} } }],
    ['replace: unknown type', base, { fn: 'applyReplaceStep', args: { stepId: 'a', newType: 'nope', spec: {} } }],
    ['replace: no spec', base, { fn: 'applyReplaceStep', args: { stepId: 'a', newType: 'notification' } }],
    ['replace: unknown step', base, { fn: 'applyReplaceStep', args: { stepId: 'zz', newType: 'notification', spec: { title: 'x' } } }],
    ['replace: notification → ai_step, readers warned', base, { fn: 'applyReplaceStep', args: { stepId: 'a', newType: 'ai_step', spec: { prompt: 'p', afterStepId: 'x' } } }],
    ['replace: condition → notification rewires', base, { fn: 'applyReplaceStep', args: { stepId: 'cond', newType: 'notification', spec: { title: 'flat' } } }],
    ['replace: integration_action with step-type tool', base, { fn: 'applyReplaceStep', args: { stepId: 'a', newType: 'integration_action', spec: { tool: 'datatable', inputs: {} } } }],
    ['replace: loop-body refused', () => withSteps([{ id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'it', maxIterations: 10, body: [{ id: 'lb', type: 'notification', title: 'x', body: '', channels: ['notification'] }], label: 'Loop' }]),
        { fn: 'applyReplaceStep', args: { stepId: 'lb', newType: 'ai_step', spec: { prompt: 'p' } } }],
    ['remove: primary trigger', base, { fn: 'applyRemoveStep', args: { stepId: 'trg' } }],
    ['remove: unknown', base, { fn: 'applyRemoveStep', args: { stepId: 'zz' } }],
    ['remove: middle step reconnects, dangling reported', base, { fn: 'applyRemoveStep', args: { stepId: 'b' } }],
    ['remove: no reconnect', base, { fn: 'applyRemoveStep', args: { stepId: 'b', reconnect: false } }],
    ['remove: branching step', base, { fn: 'applyRemoveStep', args: { stepId: 'cond' } }],
    ['remove: loop-body step', () => withSteps([{ id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'it', maxIterations: 10, body: [{ id: 'lb', type: 'notification', title: 'x', body: '', channels: ['notification'] }, { id: 'lc', type: 'notification', title: '{{steps.lb.output.title}}', body: '', channels: ['notification'] }], label: 'Loop' }]),
        { fn: 'applyRemoveStep', args: { stepId: 'lb' } }],
    ['remove: additional trigger', () => { const d = base(); d.triggers = [{ id: 'trg2', type: 'trigger', kind: 'manual' }]; d.edges.push({ from: 'trg2', to: 'a' }); return d; },
        { fn: 'applyRemoveStep', args: { stepId: 'trg2' } }],
    ['findDanglingRefs: in a layer and an expression', () => { const d = base(); d.layers = { lay: { steps: [{ id: 'q', type: 'condition', expr: 'steps.c.output.y > 0' }] } }; return d; },
        { fn: 'findDanglingRefs', args: 'c' }],
];

const replacer = (_k, v) => {
    if (v instanceof Set) return { $set: [...v] };
    if (v === undefined) return { $undefined: true };
    return v;
};
const snap = (v) => JSON.parse(JSON.stringify(v, replacer));

function runScenario([, mk, call, extra]) {
    const def = mk();
    const dw = wrapOf(def, extra || {});
    const argsBefore = snap(call.args);
    let result;
    if (call.fn === 'findDanglingRefs') result = stepEditing.findDanglingRefs(def, call.args);
    else if (call.fn === 'applyRemoveStep') result = stepEditing.applyRemoveStep(def, call.args);
    else if (call.fn === 'applyReplaceStep') result = stepEditing.applyReplaceStep(def, call.args, { draft: def, scope: null }, dw);
    else result = stepEditing[call.fn](def, call.args, dw);
    return snap({ result, steps: def.steps, edges: def.edges, layers: def.layers, argsBefore, argsAfter: call.args, inspected: dw._inspectedTools });
}

test('the module exports exactly the same keys', () => {
    assert.deepStrictEqual(Object.keys(stepEditing).sort(), ['PATCHABLE_FIELDS', 'applyRemoveStep', 'applyReplaceStep', 'applyUpdateStep', 'applyUpdateSteps', 'findDanglingRefs']);
});

const actual = {};
for (const sc of SCENARIOS) actual[sc[0]] = runScenario(sc);
actual.PATCHABLE_FIELDS = snap(stepEditing.PATCHABLE_FIELDS);

if (process.env.UPDATE_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 1)}\n`);
}
const GOLDEN = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

test('every scenario is in the golden file', () => {
    assert.deepStrictEqual(Object.keys(actual).sort(), Object.keys(GOLDEN).sort());
});
for (const name of Object.keys(actual)) {
    test(`golden: ${name}`, () => {
        assert.deepStrictEqual(actual[name], GOLDEN[name]);
    });
}
