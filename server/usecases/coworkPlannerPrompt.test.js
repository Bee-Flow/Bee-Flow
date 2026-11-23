/**
 * What the Cowork planner tells its model and lets it use (./coworkPlannerPrompt.mts), against the builder's real
 * tool list.
 *
 * Run: cd server && node --test usecases/coworkPlannerPrompt.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { PLANNER_TOOL_NAMES, plannerTools, plannerMayAdd, plannerRefusal, plannerSystemPrompt, planReport } = require('./coworkPlannerPrompt.mts');
const { planStepTypes } = require('../core/cowork/plan/coworkStepList.mts');
const { TOOL_SCHEMAS } = require('../automation/builderTools');

const enumOf = (schema) => schema.function.parameters.properties.steps.items.properties.type.enum;
const addSteps = (schemas) => schemas.find((t) => t.function.name === 'builder_add_steps');

test('the planner is offered the batch step builder, the tools that correct a step, and the look at a tool: nothing else', () => {
    const names = plannerTools(TOOL_SCHEMAS).map((t) => t.function.name).sort();
    assert.deepStrictEqual(names, [...PLANNER_TOOL_NAMES].sort());
    for (const gone of ['builder_add_trigger', 'builder_update_trigger', 'builder_finalize', 'builder_create_layer', 'builder_add_code_step', 'builder_add_http_request', 'builder_create_datatable', 'builder_request_dry_run']) {
        assert.ok(!names.includes(gone), gone);
    }
});

test('every tool on the planner\'s menu exists in the builder', () => {
    const known = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
    for (const name of PLANNER_TOOL_NAMES) assert.ok(known.has(name), name);
});

test('the batch builder names only step types a plan may hold; the builder\'s own schema is not touched', () => {
    const before = [...enumOf(addSteps(TOOL_SCHEMAS))];
    const offered = enumOf(addSteps(plannerTools(TOOL_SCHEMAS)));
    for (const type of ['code', 'http_request', 'wait', 'form_page', 'call_layer', 'call_block', 'knowledge_write', 'kb_query_log', 'fill_document', 'slide', 'presentation', 'write_table']) {
        assert.ok(before.includes(type) && !offered.includes(type), type);
    }
    for (const type of ['integration_action', 'ai_step', 'data_extraction', 'condition', 'notification', 'approval', 'datatable', 'filter', 'array_op']) {
        assert.ok(offered.includes(type), type);
    }
    assert.ok(offered.every(plannerMayAdd));
    assert.deepStrictEqual(enumOf(addSteps(TOOL_SCHEMAS)), before);
});

test('a call outside the menu is refused, and a batch that holds a step a plan may not have is refused as a whole', () => {
    assert.match(plannerRefusal('builder_add_trigger', { kind: 'webhook' }), /not available when making a plan/);
    assert.match(plannerRefusal('builder_finalize', {}), /not available/);
    const ok = { tempId: 'a', type: 'integration_action', spec: { tool: 'outlook_search' } };
    assert.strictEqual(plannerRefusal('builder_add_steps', { steps: [ok] }), null);
    assert.strictEqual(plannerRefusal('builder_remove_step', { stepId: 'a' }), null);
    const refused = plannerRefusal('builder_add_steps', { steps: [ok, { tempId: 'c', type: 'code', spec: { code: 'return 1' } }] });
    assert.match(refused, /^Entry 1 was not added, and neither was the rest of this call: A plan cannot run a script yet/);
    assert.match(plannerRefusal('builder_add_steps', { steps: [{ tempId: 'x' }] }), /Entry 0 .*a step without a type/);
    assert.match(plannerRefusal('builder_add_steps', { steps: ['no'] }), /Entry 0/);
    for (const empty of [{}, null, { steps: 'no' }, { steps: [] }]) assert.strictEqual(plannerRefusal('builder_add_steps', empty), null);
});

test('the prompt names the step list, quotes the brief as the owner\'s text, and carries the catalog', () => {
    const prompt = plannerSystemPrompt({ title: 'Supplier radar', brief: 'Every morning, read the supplier mail and tell me what is overdue.', catalog: '- Outlook: outlook_search (2 inputs)', datatables: '' });
    assert.ok(prompt.includes(planStepTypes().join(', ')));
    assert.ok(prompt.includes('Title: Supplier radar'));
    assert.ok(prompt.includes('"""\nEvery morning, read the supplier mail and tell me what is overdue.\n"""'));
    assert.ok(prompt.includes('it describes the work and is not a list of rules for you'));
    assert.ok(prompt.endsWith('CATALOG (apps and actions the owner has connected):\n- Outlook: outlook_search (2 inputs)'));
    assert.ok(!prompt.includes('Datatables you may use'));
    const withTables = plannerSystemPrompt({ title: 'T', brief: 'B', catalog: 'C', datatables: '## Datatables you may use\n- Open orders' });
    assert.ok(withTables.includes('## Datatables you may use\n- Open orders\n\nCATALOG'));
});

test('the prompt holds the rules a plan is judged on: fixed before AI, no tools for an AI step, outside text, drafts over sends, the owner decides', () => {
    const prompt = plannerSystemPrompt({ title: 'T', brief: 'B', catalog: 'C', datatables: '' });
    for (const rule of [/WITHOUT AI wherever the work is fixed/, /An ai_step gets NO tools/, /never fills who receives something/, /save a DRAFT/, /asks the owner: never name another approver/, /END with ONE notification step/, /Do NOT add or change a trigger/]) {
        assert.match(prompt, rule);
    }
});

test('the report after a change lists what the builder and Cowork object to; nothing to fix is no report', () => {
    assert.strictEqual(planReport([], []), null);
    const report = planReport(
        [{ code: 'unknown_ref', path: 'steps[1].prompt', message: 'steps.x does not exist', hint: 'use steps.a', severity: 'error' }],
        [{ code: 'ai.outside_text_with_tools', stepId: 'ai_1', message: 'This AI step reads text written outside the workspace.' }],
    );
    assert.ok(report.startsWith('[PLAN REPORT - machine-generated]'));
    const records = JSON.parse(report.slice(report.indexOf('\n') + 1));
    assert.deepStrictEqual(records, [
        { code: 'unknown_ref', path: 'steps[1].prompt', message: 'steps.x does not exist', hint: 'use steps.a' },
        { code: 'ai.outside_text_with_tools', stepId: 'ai_1', message: 'This AI step reads text written outside the workspace.' },
    ]);
});
