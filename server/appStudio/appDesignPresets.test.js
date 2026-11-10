/**
 * The design presets added after the base seven (shared/appDefinition/designPresets.mjs,
 * EXTENSION_APP_DESIGN_PRESETS): each is a complete look the tools apply, marked since 3, and
 * the base seven are what they were.
 *
 * Run: node --test appStudio/appDesignPresets.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { APP_DESIGN_PRESETS, EXTENSION_APP_DESIGN_PRESETS, ALL_APP_DESIGN_PRESETS, getAppDesignPreset } = require('./appDesignPresets');
const { DESIGN_SPEC, THEME_SPEC, THEME_PRIMARY_PRESETS, NAV_STYLES, emptyDefinition } = require('./componentSpecs');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { applyToolCall, TOOL_SCHEMAS } = require('./builderTools');
const { buildSystemPrompt } = require('./builderPrompt');

const BASE_IDS = ['classic', 'cloud', 'atlas', 'midnight', 'field', 'paper', 'mono'];
const wrap = () => ({ userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs', def: emptyDefinition('Presets') });

test('the base seven are untouched and unmarked; later presets follow them, each marked since 3', () => {
    assert.deepEqual(APP_DESIGN_PRESETS.map((p) => p.id), BASE_IDS);
    for (const p of APP_DESIGN_PRESETS) assert.strictEqual(p.since, undefined, p.id);
    assert.ok(EXTENSION_APP_DESIGN_PRESETS.length >= 6);
    for (const p of EXTENSION_APP_DESIGN_PRESETS) {
        assert.strictEqual(p.since, 3, p.id);
        assert.strictEqual(DESIGN_SPEC.preset.valuesSince[p.id], 3, `${p.id} is marked in the spec`);
        assert.strictEqual(getAppDesignPreset(p.id), p);
    }
    assert.deepEqual(ALL_APP_DESIGN_PRESETS.map((p) => p.id), DESIGN_SPEC.preset.values.filter((v) => v !== 'custom'), 'spec enum = custom + every preset, base first');
    assert.deepEqual(DESIGN_SPEC.preset.values.slice(0, 8), ['custom', ...BASE_IDS]);
    assert.strictEqual(DESIGN_SPEC.preset.default, 'custom');
});

test('every later preset is a complete look from the existing vocabulary, and no two presets are the same look', () => {
    const primaries = THEME_PRIMARY_PRESETS.map((c) => (typeof c === 'string' ? c : c.value || c.hex));
    const looks = new Set();
    for (const p of ALL_APP_DESIGN_PRESETS) {
        assert.ok(p.name && p.description, p.id);
        assert.strictEqual(p.design.preset, p.id);
        for (const key of ['radius', 'density', 'fontScale', 'appearance']) assert.ok(THEME_SPEC[key].values.includes(p.theme[key]), `${p.id}.theme.${key}`);
        for (const key of ['font', 'surface', 'motion', 'chartPalette', 'accentEdge']) assert.ok(DESIGN_SPEC[key].values.includes(p.design[key]), `${p.id}.design.${key}`);
        assert.ok(NAV_STYLES.includes(p.navStyle), `${p.id}.navStyle`);
        assert.ok(primaries.includes(p.theme.primary), `${p.id} primary is a house colour`);
        looks.add(JSON.stringify([p.theme, { ...p.design, preset: null }, p.navStyle]));
    }
    assert.strictEqual(looks.size, ALL_APP_DESIGN_PRESETS.length);
});

test('app_set_theme applies a later preset like any other; the stored app needs schema version 3, a base preset does not', async () => {
    for (const p of EXTENSION_APP_DESIGN_PRESETS) {
        const w = wrap();
        const result = await applyToolCall('app_set_theme', { preset: p.id }, w);
        assert.strictEqual(result.error, undefined, `${p.id}: ${result.error}`);
        assert.deepEqual(result._hints || [], [], p.id);
        assert.deepEqual(w.def.theme, { ...w.def.theme, ...p.theme });
        assert.deepEqual(w.def.design, p.design);
        assert.deepEqual(validateAppDefinition(w.def).errors, []);
        assert.strictEqual(canonicalizeAppDefinition(JSON.parse(JSON.stringify(w.def))).def.schemaVersion, 3, p.id);
    }
    const base = wrap();
    await applyToolCall('app_set_theme', { preset: 'cloud' }, base);
    assert.ok(canonicalizeAppDefinition(JSON.parse(JSON.stringify(base.def))).def.schemaVersion < 3);
    const unknown = await applyToolCall('app_set_theme', { preset: 'neon' }, wrap());
    for (const p of ALL_APP_DESIGN_PRESETS) assert.ok(unknown.error.includes(p.id), `the refusal lists ${p.id}`);
});

test('the AI reads about a later preset through the extension tier, and the base tool schema lists the base seven', async () => {
    const schema = TOOL_SCHEMAS.find((t) => t.function.name === 'app_set_theme').function.parameters.properties.preset;
    assert.deepEqual(schema.enum, BASE_IDS);
    const prompt = buildSystemPrompt({ ownerContext: 'note' });
    for (const p of EXTENSION_APP_DESIGN_PRESETS) {
        assert.ok(prompt.includes(p.id), `${p.id} is named in the prompt's Extensions list`);
        const name = `design.preset=${p.id}`;
        const answer = await applyToolCall('app_inspect_catalog', { extensions: [name] }, wrap());
        assert.ok(answer.extensions && answer.extensions[name], `${name} is served`);
        assert.match(answer.extensions[name], /app_set_theme \{preset:"<id>"\}/);
    }
    // The small band's prompt names the base seven only.
    const core = buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' });
    for (const p of EXTENSION_APP_DESIGN_PRESETS) assert.ok(!new RegExp(`\\b${p.id}\\b`).test(core), `${p.id} is not in the small band's prompt`);
});
