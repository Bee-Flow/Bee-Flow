/**
 * Tool-schema text must agree with the lean prompt's doctrine.
 *
 * A small model follows the concrete JSON example sitting next to the decision
 * over prose 15k tokens earlier. An audit (2026-09-11) found the loop-container
 * idiom surviving in three schema places after it was removed from the prompt,
 * type enums missing types the engine accepts, and the batch-update tool — the
 * one the dry-run repair path points at — carrying no rules at all. These tests
 * keep the schemas from drifting back.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/schemas.doctrine.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { TOOL_SCHEMAS, applyToolCall, emptyDefinition } = require('../builderTools');
const { ADD_FOR_TYPE } = require('./stepBuilders');
const { buildFewShotMessages, buildLeanSystemPrompt } = require('../builderPrompt');
const { iterableFieldsOf, describeShape } = require('../outputSchemas');
const { CORE_TOOL_NAMES } = require('../builderModelProfiles');
const { validateDefinition } = require('../validate');

const tool = (n) => TOOL_SCHEMAS.find(t => t.function.name === n).function;
const props = (n) => tool(n).parameters.properties;

test('every step type the engine accepts can be batched, and the batch enum names nothing the engine rejects', () => {
    const en = props('builder_add_steps').steps.items.properties.type.enum;
    for (const k of Object.keys(ADD_FOR_TYPE)) {
        if (k === 'guard' || k === 'tokenize') continue; // Privacy Shield nodes have their own tools
        assert.ok(en.includes(k), `${k} is accepted by ADD_FOR_TYPE but missing from the batch enum`);
    }
    for (const k of en) assert.ok(ADD_FOR_TYPE[k] || k === 'array_op', `${k} is in the enum but the engine cannot build it`);
    for (const k of ['http_request', 'datatable', 'generate_document']) assert.ok(en.includes(k));
});

test('builder_replace_step can replace into every engine type', () => {
    const en = props('builder_replace_step').newType.enum;
    for (const k of ['http_request', 'datatable', 'generate_document']) assert.ok(en.includes(k), k);
    for (const k of en) assert.ok(ADD_FOR_TYPE[k], `${k} cannot be built by applyReplaceStep`);
});

test('the batch spec text teaches chained forEach with a worked example, and no longer singles out loop', () => {
    const d = props('builder_add_steps').steps.items.properties.spec.description;
    assert.match(d, /forEach:\{overRef,itemVar\} INSIDE spec/);
    assert.match(d, /steps\.\$read\.output\.results/);
    assert.match(d, /RARE/);
    assert.ok(!/EXCEPTION: for type "loop"/.test(d));
});

test('add_action and add_ai_step demonstrate forEach, not a shared loop item', () => {
    for (const n of ['builder_add_action', 'builder_add_ai_step']) {
        const d = tool(n).description;
        assert.match(d, /forEach/, `${n} must name forEach`);
        assert.ok(!/loop\.email\./.test(d), `${n} still carries the loop-container exemplar`);
    }
});

test('add_condition: branch/caseName exist and functions are not forbidden', () => {
    const p = props('builder_add_condition');
    assert.ok(p.branch && Array.isArray(p.branch.enum));
    assert.ok(p.caseName);
    assert.ok(!/NO function calls/.test(tool('builder_add_condition').description));
    // A3: rules are taught in the shapes the editor reopens as rows, never
    // wrapped in lower()/upper() (the text helpers ignore case already).
    assert.match(tool('builder_add_condition').description, /equals\(/);
    assert.ok(!/contains\(lower\(/.test(tool('builder_add_condition').description));
});

test('update_step documents the move; update_steps carries the same rules', () => {
    assert.match(tool('builder_update_step').description, /MOVES a step/);
    assert.match(props('builder_update_step').patch.description, /afterStepId/);
    const up = props('builder_update_steps').updates.items.properties.patch;
    assert.ok(up.description && /afterStepId/.test(up.description) && /binding/.test(up.description));
    assert.match(tool('builder_update_steps').description, /dry-run/);
});

test('array_op no longer vouches for tools outside the served menu', () => {
    assert.ok(!/legacy/.test(tool('builder_add_array_op').description));
});

test('the few-shots echo builder_set_plan the way the route really does', () => {
    const msgs = buildFewShotMessages(3);
    const planCallIds = new Set();
    for (const m of msgs) for (const tc of (m.tool_calls || [])) if (tc.function.name === 'builder_set_plan') planCallIds.add(tc.id);
    assert.ok(planCallIds.size >= 1);
    for (const m of msgs) {
        if (m.role !== 'tool' || !planCallIds.has(m.tool_call_id)) continue;
        const echo = JSON.parse(m.content);
        assert.ok(Array.isArray(echo.todos) && echo.todos.every(t => 'i' in t && 'text' in t && 'done' in t), 'todos with i/text/done');
        assert.ok('next' in echo);
        assert.ok(!('count' in echo), 'the old {ok,count} shape is what taught the model the plan was unreadable');
    }
});

// ── A8: the fan-out few-shot must be something the small profile can DO ──────
//
// A few-shot that calls a tool outside the core menu teaches the small model
// a call it will then be refused for (builderConvergence 2026-09-11: the
// prompt advertised tools the model could not call, and every such call cost
// a round). And a few-shot whose batch the real builders would reject teaches
// a shape that fails on first contact. Both are checked here, not by eye.

test('every tool the core few-shots call is in the core menu', () => {
    const msgs = buildFewShotMessages(3, { toolset: 'core' });
    const called = new Set();
    for (const m of msgs) for (const tc of (m.tool_calls || [])) called.add(tc.function.name);
    assert.ok(called.size >= 5, 'sanity: the few-shots call several tools');
    for (const name of called) assert.ok(CORE_TOOL_NAMES.has(name), `${name} is called in a core few-shot but is not in CORE_TOOL_NAMES`);
});

test('the invoice few-shot replays against the real builders', async () => {
    const msgs = buildFewShotMessages(3, { toolset: 'core' });
    // The batch whose entries include a datatable write — the invoice example,
    // found by content rather than by sentinel id so a re-numbering cannot
    // silently make this test replay the wrong batch.
    const call = msgs.flatMap(m => m.tool_calls || [])
        .filter(tc => tc.function.name === 'builder_add_steps')
        .map(tc => JSON.parse(tc.function.arguments))
        .find(a => Array.isArray(a.steps) && a.steps.some(s => s.type === 'datatable'));
    assert.ok(call, 'the few-shots carry a builder_add_steps batch with a datatable entry');

    const ncPath = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    const wrap = {
        userId: 'u_test',
        def: emptyDefinition(),
        _inputSchemasByTool: { nextcloud_list_files: ncPath, nextcloud_read_file: ncPath },
        _availableToolNames: new Set(['nextcloud_list_files', 'nextcloud_read_file']),
        // The few-shot inspects both tools first; the gate would otherwise
        // refuse the read step, whose one required input is bound.
        _inspectedTools: new Set(['nextcloud_list_files', 'nextcloud_read_file']),
        _datatables: [{
            id: 'tbl_1a2b3c', key: 'facturen', name: 'Facturen', canWrite: true,
            columns: [
                { key: 'datum', name: 'Datum', type: 'date' },
                { key: 'leverancier', name: 'Leverancier', type: 'text' },
                { key: 'factuurnummer', name: 'Factuurnummer', type: 'text' },
                { key: 'excl_btw', name: 'Excl. btw', type: 'number' },
                { key: 'btw', name: 'Btw', type: 'number' },
                { key: 'totaal', name: 'Totaal', type: 'number' },
            ],
        }],
    };
    const trig = await applyToolCall('builder_propose_trigger', { kind: 'manual' }, wrap);
    assert.ok(!trig.error, trig.error);
    const r = await applyToolCall('builder_add_steps', call, wrap);
    assert.ok(!r.error, `the real builders must accept the few-shot batch: ${r.error}`);
    assert.strictEqual(r.added.length, 4, 'four steps');
    assert.strictEqual(wrap.def.steps.length, 4);
    assert.deepStrictEqual(wrap.def.steps.map(s => s.type), ['integration_action', 'integration_action', 'data_extraction', 'datatable']);

    // The example's placeholder id resolves through the key onto the real
    // table — that note is the ONLY repair the builders may have to make.
    const save = wrap.def.steps.find(s => s.type === 'datatable');
    assert.strictEqual(save.datatableId, 'tbl_1a2b3c');
    assert.strictEqual(save.datatableKey, 'facturen');
    const other = (r._warnings || []).filter(w => !/datatableId "tbl_fact01" is not a table here; datatableKey "facturen" resolved it to tbl_1a2b3c/.test(w));
    assert.deepStrictEqual(other, [], 'no repair beyond the id→key resolution note');

    // Chained forEach: each fan-out reads the previous one's results.
    const [list, read, extract] = wrap.def.steps;
    assert.strictEqual(read.forEach.overRef, `steps.${list.id}.output.items`);
    assert.strictEqual(extract.forEach.overRef, `steps.${read.id}.output.results`);
    assert.strictEqual(save.forEach.overRef, `steps.${extract.id}.output.results`);

    const v = validateDefinition(wrap.def);
    assert.deepStrictEqual(v.errors, [], `the validator accepts the replayed draft: ${JSON.stringify(v.errors)}`);
});

test('nextcloud_list_files declares its array so forEach has one obvious target', () => {
    assert.deepStrictEqual(iterableFieldsOf('nextcloud_list_files'), ['items']);
    assert.match(describeShape('nextcloud_list_files'), /items: array/);
});

test('the lean prompt says how to move a step and when NOT to stop', () => {
    const p = buildLeanSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: false, batchTools: true });
    assert.match(p, /afterStepId:"<id>", branch:"else"/);
    assert.match(p, /core of what the user asked/);
    assert.match(p, /do not stop to ask/);
    // The dry-run repair tool on the lean menu is builder_update_step, one
    // call per failing step in the same reply — builder_update_steps is
    // dropped by the lean projection (schemaProjection.js DROP_TOOLS_SMALL).
    assert.match(p, /builder_update_step\b/);
    assert.ok(!/builder_update_steps/.test(p), 'the lean prompt must not point at the batch update the small menu lacks');
});
