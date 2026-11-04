'use strict';

/**
 * "## What you can build": rendered from the step-type table, in the ribbon's
 * groups and order, with spec keys the builders really take.
 *
 * Run: cd server && node --test automation/builderPrompt/stepFamilies.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderWhatYouCanBuild, FAMILIES, WHEN, SPEC } = require('./stepFamilies');
const { STEP_TYPE_TABLE, BATCH_STEP_TYPES, CANVAS_ONLY_STEP_TYPES } = require('../builderTools/stepTypeTable');
const { TOOL_SCHEMAS, applyToolCall, emptyDefinition } = require('../builderTools');

const listed = STEP_TYPE_TABLE.filter((e) => e.authoring !== 'retired').map((e) => e.type);

test('every type a person can meet has a when-line, and nothing else does', () => {
    assert.deepEqual(Object.keys(WHEN).sort(), [...listed].sort());
});

test('the groups are the ribbon tabs in tab order, and each type sits in its own', () => {
    assert.deepEqual(FAMILIES.map((f) => f.heading), ['How it starts', 'AI', 'Logic', 'People', 'Data & documents', 'Apps', 'My building blocks']);
    const text = renderWhatYouCanBuild();
    const at = FAMILIES.map((f) => text.indexOf(`### ${f.heading}\n`));
    assert.ok(at.every((i) => i > 0), 'every group heading is rendered');
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in ribbon order');
    for (const e of STEP_TYPE_TABLE.filter((x) => x.authoring !== 'retired')) {
        const fam = FAMILIES.findIndex((f) => f.id === e.family);
        const line = text.indexOf(`- ${e.userLabel} [${e.type}] — `);
        assert.ok(line > at[fam] && (fam === at.length - 1 || line < at[fam + 1]), `${e.type} is listed under ${FAMILIES[fam].heading}`);
    }
    assert.ok(!text.includes('[parse_json]'), 'a retired type is not offered');
});

test('the spec keys are exactly the batch types, and each key is one the builder takes', async () => {
    assert.deepEqual(Object.keys(SPEC).sort(), [...BATCH_STEP_TYPES].sort());
    const toolOf = { integration_action: 'builder_add_action', code: 'builder_add_code_step', flatten: 'builder_add_array_op' };
    const keysOf = (type) => SPEC[type].split(/[,|]/).map((k) => k.trim().replace(/\?$/, '').split(/[:\s]/)[0]).filter(Boolean);
    for (const type of BATCH_STEP_TYPES) {
        const name = toolOf[type] || `builder_add_${type}`;
        const tool = TOOL_SCHEMAS.find((t) => t.function.name === name);
        if (!tool) continue;
        const props = tool.function.parameters.properties;
        for (const k of keysOf(type)) assert.ok(k in props, `${type}: spec key ${k} is a property of ${name}`);
    }
    // The types with no single-step tool: a batch entry with exactly those keys builds.
    const wrap = { userId: 'u', def: emptyDefinition() };
    await applyToolCall('builder_propose_trigger', { kind: 'form', form: { fields: [{ name: 'sheet', type: 'file' }] } }, wrap);
    const r = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'n', type: 'set', spec: { fields: { t: { kind: 'literal', value: 'x' } } } },
        { tempId: 'g', type: 'guard', spec: { sourceRef: 'steps.$n.output.t' } },
        { tempId: 'k', type: 'tokenize', spec: { sourceRef: 'steps.$n.output.t', afterStepId: '$g', branch: 'else' } },
        { tempId: 'u', type: 'untokenize', spec: { sourceRef: 'steps.$k.output.text' } },
        { tempId: 'r', type: 'read_table', spec: { source: { kind: 'ref', path: 'trigger.output.sheet' } } },
        { tempId: 't', type: 'table', spec: { source: { kind: 'ref', path: 'steps.$r.output.table' }, ops: [] } },
    ] }, wrap);
    assert.ok(!r.error, r.error);
    for (const type of ['guard', 'tokenize', 'untokenize', 'read_table', 'table']) {
        assert.ok(!TOOL_SCHEMAS.some((t) => t.function.name === `builder_add_${type}`), `${type} has no single-step tool, so the batch check above is the one`);
    }
});

test('full: one line per type, no spec keys; canvas-only types point at the canvas-only entries', () => {
    const text = renderWhatYouCanBuild({ variant: 'full', codeStepEnabled: true });
    assert.ok(text.startsWith('## What you can build\n\n'));
    assert.ok(!text.includes('Spec {'), 'the per-type tools carry the fields on this menu');
    for (const { type } of CANVAS_ONLY_STEP_TYPES) assert.match(text, new RegExp(`\\[${type}\\] — canvas only: you cannot add it \\(see CANVAS-ONLY below\\)\\.`));
    assert.match(text, /- Code \[code\] — your own JavaScript/);
    assert.match(text, /- Ask someone to approve \[approval\] — pause until a person approves or rejects\./);
    assert.ok(!text.includes('Not on your tool menu'), 'the full menu makes every one of them');
});

test('compact: spec keys on every batch type, the canvas-only behaviour inline, and what the lean menu cannot make', () => {
    const text = renderWhatYouCanBuild({ variant: 'compact', codeStepEnabled: false, leanMenu: true });
    assert.match(text, /- Extract data \[data_extraction\] — [^\n]* Spec \{source, fields\}/);
    assert.match(text, /- Back to the app \[return_to_app\] — canvas only: you cannot add it\. In a draft: TERMINAL/);
    assert.match(text, /- Code \[code\] — switched off on this server; never propose it\./);
    assert.match(text, /- Note \[note\] — [^\n]*Not on your tool menu\./);
    assert.match(text, /\n\nNot on your tool menu: a new flowlet, a second trigger and a note\./);
    const reasoning = renderWhatYouCanBuild({ variant: 'compact', codeStepEnabled: false, leanMenu: false });
    assert.ok(!reasoning.includes('Not on your tool menu'));
});

test('the block names no builder tool, so no band reads about a tool its menu lacks', () => {
    for (const opts of [{ variant: 'full', codeStepEnabled: true }, { variant: 'compact', codeStepEnabled: true, leanMenu: true }]) {
        assert.doesNotMatch(renderWhatYouCanBuild(/** @type {any} */ (opts)), /builder_[a-z]/);
    }
});
