/**
 * The `design` of a build plan (planDesign.mts): bounded, never invented, absent when empty.
 *
 * Run: node --test appStudio/builderTools/planDesign.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { boundPlanDesign, hexColour, PLAN_DESIGN_LIMITS } = require('./planDesign.mts');
const { boundPlanArtifact, applyToolCall, TOOL_SCHEMAS } = require('../builderTools');
const { emptyDefinition, DESIGN_SPEC, NAV_STYLES } = require('../componentSpecs');
const { ALL_APP_DESIGN_PRESETS } = require('../appDesignPresets');
const { renderApprovedPlanNote } = require('../../usecases/ai/appStudioBuilder/turnNotes');

const BASE = { title: 'Repairs', summary: 'Report and follow repairs.', screens: [{ name: 'Home', purpose: 'Overview', contents: ['hero'] }] };

test('a plan without a design is the plan it always was', () => {
    assert.deepEqual(Object.keys(boundPlanArtifact(BASE).plan), ['title', 'summary', 'screens']);
    for (const junk of [null, 'warm', [], {}, { preset: 'neon' }, { primary: 'red' }, { signatureMoves: [] }]) {
        assert.strictEqual(boundPlanDesign(junk), undefined);
        assert.ok(!('design' in boundPlanArtifact({ ...BASE, design: junk }).plan));
    }
    assert.ok(!renderApprovedPlanNote(boundPlanArtifact(BASE).plan).includes('signature move'));
});

test('a design is capped, normalised and keeps only values app_set_theme takes', () => {
    const design = boundPlanDesign({
        direction: `  ${'d'.repeat(400)}`, preset: 'Ember', primary: '#c2410c', font: 'Comic Sans', navStyle: 'SIDEBAR', surface: 'glass',
        signatureMoves: ['one', '', 7, 'm'.repeat(300), 'three', 'four'], extra: 'dropped',
    });
    assert.strictEqual(design.direction.length, PLAN_DESIGN_LIMITS.DIRECTION);
    assert.deepEqual({ ...design, direction: undefined, signatureMoves: undefined }, { direction: undefined, preset: 'ember', primary: '#C2410C', navStyle: 'sidebar', signatureMoves: undefined });
    assert.deepEqual(design.signatureMoves.map((m) => m.length), [3, PLAN_DESIGN_LIMITS.MOVE, 5]);
    assert.strictEqual(hexColour('#12345'), undefined);
    assert.strictEqual(hexColour('#12345g'), undefined);
    assert.strictEqual(hexColour(' #0f766e '), '#0F766E');
});

test('every preset, font, nav style and surface the spec has is accepted, "custom" included', () => {
    for (const preset of ['custom', ...ALL_APP_DESIGN_PRESETS.map((p) => p.id)]) assert.strictEqual(boundPlanDesign({ preset }).preset, preset);
    for (const font of DESIGN_SPEC.font.values) assert.strictEqual(boundPlanDesign({ font }).font, font);
    for (const navStyle of NAV_STYLES) assert.strictEqual(boundPlanDesign({ navStyle }).navStyle, navStyle);
    for (const surface of DESIGN_SPEC.surface.values) assert.strictEqual(boundPlanDesign({ surface }).surface, surface);
});

test('app_propose_plan carries the design to the route, the schema describes it, and the approved note asks for it', async () => {
    const design = { direction: 'A warm field tool.', preset: 'field', primary: '#C2410C', font: 'general-sans', navStyle: 'tabs', surface: 'soft', signatureMoves: ['A hero greeting', 'One gradient tile', 'Cards on a band'] };
    const result = await applyToolCall('app_propose_plan', { ...BASE, design }, { def: emptyDefinition('Plan') });
    assert.strictEqual(result.presented, true);
    assert.deepEqual(result.plan.design, design);
    const schema = TOOL_SCHEMAS.find((t) => t.function.name === 'app_propose_plan').function.parameters;
    assert.deepEqual(Object.keys(schema.properties.design.properties), ['direction', 'preset', 'primary', 'font', 'navStyle', 'surface', 'signatureMoves']);
    assert.strictEqual(Object.keys(schema.properties).at(-1), 'design', 'appended after the existing parameters');
    assert.deepEqual(schema.required, ['title', 'summary', 'screens'], 'the design is never required');
    const note = renderApprovedPlanNote(result.plan);
    assert.match(note, /Its `design` is the look the user approved: set it with app_set_theme before the first component/);
    assert.ok(note.endsWith(JSON.stringify(result.plan)));
});
