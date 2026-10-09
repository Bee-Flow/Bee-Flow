'use strict';

/**
 * One table answers "which step types can the AI builder author" — and the tool
 * enums, the apply map and the prompt all read it. These tests are the net that
 * keeps it that way:
 *
 *   - every step type the validator knows is accounted for in the table (so a
 *     new runtime step type cannot be added without deciding, here, whether the
 *     builder can make it);
 *   - the batch and replace enums, ADD_FOR_TYPE and the table agree;
 *   - a canvas-only type is in no enum and no builder, and the model is told so;
 *   - the full prompt names every creatable type and teaches nothing no tool can
 *     do; the lean prompt says it holds the reduced menu and what that leaves out;
 *   - the Privacy Shield steps (guard, tokenize, untokenize) really are
 *     authorable: batch entry, $tempId refs in sourceRef, branches, patch, replace.
 *
 * Run: cd server && node --test automation/builderTools/stepTypeTable.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    STEP_TYPE_TABLE, BATCH_STEP_TYPES, REPLACEABLE_STEP_TYPES, CANVAS_ONLY_STEP_TYPES, ARRAY_OP_FAMILY, canvasOnlyMenu,
} = require('./stepTypeTable');
const { VALID_STEP_TYPES } = require('../validate/constants');
const { TOOL_SCHEMAS, applyToolCall, emptyDefinition } = require('../builderTools');
const { ADD_FOR_TYPE } = require('./stepBuilders');
const { validateDefinition } = require('../validate');
const { buildFullSystemPrompt, buildLeanSystemPrompt } = require('../builderPrompt');
const { leanBatchTypes, projectToolSchemas, LEAN_BATCH_TYPES } = require('./schemaProjection');

const schemaOf = (name) => TOOL_SCHEMAS.find(t => t.function.name === name);
const enumOf = (tool, prop) => {
    const p = schemaOf(tool).function.parameters.properties;
    return prop === 'type' ? p.steps.items.properties.type.enum : p[prop].enum;
};

test('every step type the validator knows is decided in the table', () => {
    const inTable = new Set(STEP_TYPE_TABLE.map(e => e.type));
    const missing = [...VALID_STEP_TYPES].filter(t => !inTable.has(t));
    assert.deepEqual(missing, [], `decide whether the builder can author: ${missing.join(', ')}`);
    const unknown = STEP_TYPE_TABLE.filter(e => !e.builderOnly && !VALID_STEP_TYPES.has(e.type)).map(e => e.type);
    assert.deepEqual(unknown, [], `the table lists a type the validator does not know: ${unknown.join(', ')}`);
});

test('no type is listed twice, and every entry has a known authoring mode', () => {
    const types = STEP_TYPE_TABLE.map(e => e.type);
    assert.equal(new Set(types).size, types.length);
    for (const e of STEP_TYPE_TABLE) assert.ok(['batch', 'tool', 'managed', 'retired', 'canvas_only'].includes(e.authoring), `${e.type}: ${e.authoring}`);
    for (const e of STEP_TYPE_TABLE.filter(x => x.authoring === 'canvas_only')) assert.ok(e.reason && e.reason.length > 20, `${e.type} says why`);
});

test('the batch enum of builder_add_steps IS the table', () => {
    assert.deepEqual(enumOf('builder_add_steps', 'type'), [...BATCH_STEP_TYPES]);
});

test('the replace enum of builder_replace_step IS the table, and equals the apply map', () => {
    assert.deepEqual(enumOf('builder_replace_step', 'newType'), [...REPLACEABLE_STEP_TYPES]);
    assert.deepEqual(Object.keys(ADD_FOR_TYPE).sort(), [...REPLACEABLE_STEP_TYPES].sort());
    // array_op is a family dispatched on `op`: batch yes, replace no.
    assert.ok(BATCH_STEP_TYPES.includes('array_op') && !REPLACEABLE_STEP_TYPES.includes('array_op'));
});

test('the Privacy Shield steps are authorable (they were in ADD_FOR_TYPE but in no enum and no prompt)', () => {
    for (const t of ['guard', 'tokenize', 'untokenize']) {
        assert.ok(BATCH_STEP_TYPES.includes(t), `${t} in the batch enum`);
        assert.ok(REPLACEABLE_STEP_TYPES.includes(t), `${t} in the replace enum`);
        assert.equal(typeof ADD_FOR_TYPE[t], 'function', `${t} has a builder`);
    }
});

test('canvas-only types are in no enum and no builder, and the batch refuses them by name', async () => {
    assert.deepEqual(CANVAS_ONLY_STEP_TYPES.map(e => e.type).sort(), ['call_block', 'parallel', 'return_to_app']);
    for (const { type } of CANVAS_ONLY_STEP_TYPES) {
        assert.ok(!BATCH_STEP_TYPES.includes(type), `${type} not in the batch enum`);
        assert.ok(!REPLACEABLE_STEP_TYPES.includes(type), `${type} not in the replace enum`);
        assert.equal(ADD_FOR_TYPE[type], undefined, `${type} has no builder`);
        const wrap = { userId: 'u', def: emptyDefinition() };
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, wrap);
        const r = await applyToolCall('builder_add_steps', { steps: [{ type, spec: {} }] }, wrap);
        assert.match(r.error, new RegExp(`unknown type "${type}"`));
        assert.equal(wrap.def.steps.length, 0, 'nothing was added');
    }
});

test('the full prompt names every creatable step type and states the canvas-only ones as such', () => {
    const prompt = buildFullSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: true });
    for (const t of BATCH_STEP_TYPES) assert.ok(prompt.includes(t), `the full prompt never mentions ${t}`);
    assert.ok(prompt.includes(canvasOnlyMenu()), 'the canvas-only entries come from the table');
    for (const { type } of CANVAS_ONLY_STEP_TYPES) assert.ok(prompt.includes(`  ${type}`), `${type} keeps an entry in the step menu (terminalSteps.test.js)`);
    assert.match(prompt, /return_to_app\s+— CANVAS-ONLY, you cannot create it[^\n]*TERMINAL: it ends the run[^\n]*Nothing after it ever runs/);
    // return_to_app used to be taught as a step to add; it must not be again.
    assert.doesNotMatch(prompt, /return_to_app\s+— TERMINAL/);
    assert.doesNotMatch(prompt, /builder_add_return_to_app|builder_add_parallel|builder_add_call_block/);
});

test('every tool the prompt\'s step list names as creating a type exists', () => {
    const prompt = buildFullSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: true });
    // builder_ask_questions is handled by the chat route in a work mode
    // (workMode.QUESTIONS_TOOL), not by builderTools; the prompt names it for
    // the table-choice rule.
    const names = new Set([...TOOL_SCHEMAS.map(t => t.function.name), 'builder_ask_questions']);
    const named = [...new Set(prompt.match(/builder_[a-z_]*[a-z](?![a-z_<])/g) || [])];
    const unknown = named.filter(n => !names.has(n));
    assert.deepEqual(unknown, [], `the prompt names tools that do not exist: ${unknown.join(', ')}`);
});

test('the lean prompt says it holds the reduced menu, and lists exactly what the menu leaves out', () => {
    const lean = buildLeanSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: false, batchTools: true, catalogPlacement: 'dynamic', menu: 'lean' });
    assert.match(lean, /## This is the reduced menu/);
    const section = lean.slice(lean.indexOf('## This is the reduced menu'), lean.indexOf('## Naming'));
    const buildable = /Step types you can build: ([^(]+) \(/.exec(section)[1].split(', ').map(s => s.trim());
    assert.deepEqual(buildable, leanBatchTypes({ codeStepEnabled: false }));
    const notOn = /NOT on this menu: ([^.]+)\./.exec(section)[1].split(', ').map(s => s.trim());
    const covered = new Set([...buildable, ...ARRAY_OP_FAMILY, 'code']);
    assert.deepEqual(notOn.filter(t => BATCH_STEP_TYPES.includes(t)), BATCH_STEP_TYPES.filter(t => !covered.has(t)), 'the gap list is the table minus the menu');
    assert.ok(notOn.includes('guard') && notOn.includes('switch') && notOn.includes('wait'));
    assert.match(section, /Never claim a step you could not create/);
    // The reasoning band reads lean prose beside the FULL menu: no notice there.
    assert.doesNotMatch(buildLeanSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: false, batchTools: true, menu: 'full' }), /reduced menu/);
});

test('the lean batch enum gains `code` only when code steps are enabled, in step with the lean prompt', () => {
    const tools = TOOL_SCHEMAS.filter(t => t.function.name === 'builder_add_steps');
    const off = projectToolSchemas(tools, { variant: 'lean' })[0].function.parameters.properties.steps.items.properties.type.enum;
    const on = projectToolSchemas(tools, { variant: 'lean', codeStepEnabled: true })[0].function.parameters.properties.steps.items.properties.type.enum;
    assert.deepEqual(off, [...LEAN_BATCH_TYPES], 'the common case keeps its bytes');
    assert.deepEqual(on, [...LEAN_BATCH_TYPES, 'code']);
    const leanOn = buildLeanSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: true, batchTools: true });
    assert.match(leanOn, /then a `code` entry/, 'the prompt promises a code entry…');
    assert.ok(on.includes('code'), '…so the enum must contain one');
    assert.match(leanOn, /Step types you can build: [^(]*\bcode\b/);
    // The full menu is untouched by the flag.
    assert.strictEqual(projectToolSchemas(tools, { variant: 'full', codeStepEnabled: true }), tools);
});

// ── The Privacy Shield steps, end to end ────────────────────────────────

const freshManual = async () => {
    const wrap = { userId: 'u', def: emptyDefinition() };
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, wrap);
    return wrap;
};

test('guard → branches → tokenize → untokenize build in ONE batch, with $tempId refs in sourceRef', async () => {
    const wrap = await freshManual();
    const r = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'note', type: 'set', spec: { fields: { text: { kind: 'literal', value: 'Mail from Anna' } } } },
        { tempId: 'g', type: 'guard', spec: { sourceRef: 'steps.$note.output.text', hideOnFound: true, categories: ['Email'], confidence: 0.6 } },
        { tempId: 'alert', type: 'notification', spec: { title: 'PII found', body: 'x', afterStepId: '$g', branch: 'then' } },
        { tempId: 'ok', type: 'notification', spec: { title: 'Clean', body: 'x', afterStepId: '$g', branch: 'else' } },
        { tempId: 't', type: 'tokenize', spec: { sourceRef: 'steps.$note.output.text', afterStepId: '$ok' } },
        { tempId: 'u', type: 'untokenize', spec: { sourceRef: 'steps.$t.output.text' } },
    ] }, wrap);
    assert.ok(!r.error, r.error);
    const id = r.idMap;
    const step = (k) => wrap.def.steps.find(s => s.id === id[k]);
    assert.equal(step('g').type, 'guard');
    assert.equal(step('g').sourceRef, `steps.${id.note}.output.text`, 'the $tempId in sourceRef was rewritten');
    assert.deepEqual(step('g').onFound, { tokenize: true });
    assert.deepEqual(step('g').categories, ['Email']);
    assert.equal(step('g').confidence, 0.6);
    assert.equal(step('t').sourceRef, `steps.${id.note}.output.text`);
    assert.equal(step('u').type, 'untokenize');
    assert.equal(step('u').sourceRef, `steps.${id.t}.output.text`);
    // The guard branches like a condition: then = found, else = clean.
    const out = wrap.def.edges.filter(e => e.from === id.g);
    assert.deepEqual(out.map(e => [e.to, e.label]).sort(), [[id.alert, 'then'], [id.ok, 'else']].sort());
    const v = validateDefinition(wrap.def);
    assert.deepEqual(v.errors.map(e => e.code), [], JSON.stringify(v.errors));
});

test('appending after a guard without a branch auto-labels then, then else (like a condition)', async () => {
    const wrap = await freshManual();
    const r = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'n', type: 'set', spec: { fields: { t: { kind: 'literal', value: 'x' } } } },
        { tempId: 'g', type: 'guard', spec: { sourceRef: 'steps.$n.output.t' } },
        { tempId: 'a', type: 'notification', spec: { title: 'a', body: 'a', afterStepId: '$g' } },
        { tempId: 'b', type: 'notification', spec: { title: 'b', body: 'b', afterStepId: '$g' } },
    ] }, wrap);
    assert.ok(!r.error, r.error);
    const labels = wrap.def.edges.filter(e => e.from === r.idMap.g).map(e => e.label).sort();
    assert.deepEqual(labels, ['else', 'then']);
});

test('guard fields are patchable in place, and onFound is rebuilt, never merged', async () => {
    const wrap = await freshManual();
    const r = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'n', type: 'set', spec: { fields: { t: { kind: 'literal', value: 'x' } } } },
        { tempId: 'g', type: 'guard', spec: { sourceRef: 'steps.$n.output.t', stopOnFound: true } },
    ] }, wrap);
    const g = r.idMap.g;
    const p = await applyToolCall('builder_update_step', { stepId: g, patch: { onFound: { mask: true, invented: true }, confidence: 0.8, categories: ['BankAccountNumber'] } }, wrap);
    assert.ok(!p.error, p.error);
    const step = wrap.def.steps.find(s => s.id === g);
    assert.deepEqual(step.onFound, { mask: true }, 'only the three known switches survive');
    assert.equal(step.confidence, 0.8);
    assert.deepEqual(step.categories, ['BankAccountNumber']);
    assert.equal(step.id, g, 'same id, same wiring');
    const bad = await applyToolCall('builder_update_step', { stepId: g, patch: { inventedField: 1 } }, wrap);
    assert.match(bad.error, /not patchable on a guard step/);
});

test('a step can be replaced INTO a Privacy Shield step, keeping its id', async () => {
    const wrap = await freshManual();
    const r = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'n', type: 'set', spec: { fields: { t: { kind: 'literal', value: 'x' } } } },
        { tempId: 'w', type: 'wait', spec: { seconds: 5 } },
    ] }, wrap);
    const w = r.idMap.w;
    const rep = await applyToolCall('builder_replace_step', { stepId: w, newType: 'tokenize', spec: { sourceRef: `steps.${r.idMap.n}.output.t` } }, wrap);
    assert.ok(!rep.error, rep.error);
    const step = wrap.def.steps.find(s => s.id === w);
    assert.equal(step.type, 'tokenize');
    assert.equal(step.sourceRef, `steps.${r.idMap.n}.output.t`);
});

test('the batch schema describes the Privacy Shield steps, which have no single-step tool', () => {
    const spec = schemaOf('builder_add_steps').function.parameters.properties.steps.items.properties.spec.description;
    assert.match(spec, /PRIVACY SHIELD steps exist ONLY here/);
    assert.match(spec, /ref PATH STRING, not a binding object/);
    assert.ok(!TOOL_SCHEMAS.some(t => /^builder_add_(guard|tokenize|untokenize)$/.test(t.function.name)), 'and indeed there is no such tool');
});
