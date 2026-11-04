/**
 * Canonicalizer: the AI step limits. A STORED definition still loads (the cut is a repair, reported);
 * app_set_action refuses the same input instead (builderTools/definitionTools/actions.limits.test.js).
 *
 * Run: cd server && node --test appStudio/canonicalize.aiLimits.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { SECTION_STYLE_DEFAULTS } = require('./componentSpecs');

const codes = (repairs) => new Set(repairs.map((r) => r.code));

function wrap(children = [], overrides = {}) {
    return {
        schemaVersion: 1,
        meta: { name: 'T' },
        theme: {},
        homeScreenId: 'scr_main01',
        screens: [{ id: 'scr_main01', name: 'Home', sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children }] }],
        actions: {},
        ...overrides,
    };
}

// ── AI step limits: a stored definition still loads, the cut is reported ─────

const aiStepDef = (step) => wrap([], { actions: { act_ai0001: { kind: 'sequence', steps: [step] } } });
const staticSrc = (v) => ({ kind: 'static', value: v });

test('aiSchema description: 1500 kept, 2500 cut to 2000 with a repair naming both numbers', () => {
    const run = (n) => canonicalizeAppDefinition(aiStepDef({ kind: 'ai_extract', source: staticSrc('x'), schema: [{ name: 'a', type: 'string', description: 'x'.repeat(n) }] }));
    const kept = run(1500);
    assert.equal(kept.def.actions.act_ai0001.steps[0].schema[0].description.length, 1500);
    assert.ok(!codes(kept.repairs).has('ai_schema.description_truncated'));
    const cut = run(2500);
    assert.equal(cut.def.actions.act_ai0001.steps[0].schema[0].description.length, 2000);
    const r = cut.repairs.find((x) => x.code === 'ai_schema.description_truncated');
    assert.match(r.message, /2500 chars — the maximum is 2000/);
});

test('aiSchema over 40 fields is reported, not silent', () => {
    const schema = Array.from({ length: 45 }, (_, i) => ({ name: `f${i}`, type: 'string' }));
    const { def, repairs } = canonicalizeAppDefinition(aiStepDef({ kind: 'ai_extract', source: staticSrc('x'), schema }));
    assert.equal(def.actions.act_ai0001.steps[0].schema.length, 40);
    assert.match(repairs.find((x) => x.code === 'ai_schema.fields_truncated').message, /more than 40 fields/);
});

test('contextSources: 12 are kept; the 13th is dropped by label in the repair', () => {
    const sources = (n) => Array.from({ length: n }, (_, i) => ({ label: `Source ${i}`, source: staticSrc([i]) }));
    const run = (n) => canonicalizeAppDefinition(aiStepDef({ kind: 'ai_generate', prompt: 'p', resultVar: 'r', contextSources: sources(n) }));
    const twelve = run(12);
    assert.equal(twelve.def.actions.act_ai0001.steps[0].contextSources.length, 12);
    assert.ok(!codes(twelve.repairs).has('step.context_sources_truncated'));
    const thirteen = run(13);
    assert.equal(thirteen.def.actions.act_ai0001.steps[0].contextSources.length, 12);
    const r = thirteen.repairs.find((x) => x.code === 'step.context_sources_truncated');
    assert.match(r.message, /13 context sources — the maximum is 12; dropped: "Source 12"/);
});

test('contextSources label: 100 kept, 150 cut to 120 with string.truncated at the label path', () => {
    const run = (n) => canonicalizeAppDefinition(aiStepDef({ kind: 'ai_generate', prompt: 'p', resultVar: 'r', contextSources: [{ label: 'l'.repeat(n), source: staticSrc(1) }] }));
    assert.equal(run(100).def.actions.act_ai0001.steps[0].contextSources[0].label.length, 100);
    const cut = run(150);
    assert.equal(cut.def.actions.act_ai0001.steps[0].contextSources[0].label.length, 120);
    const r = cut.repairs.find((x) => x.code === 'string.truncated' && /contextSources\[0\]\.label$/.test(x.path));
    assert.ok(r, JSON.stringify(cut.repairs));
});

test('ai_generate prompt: 32000 kept, longer is truncated and reported', () => {
    const run = (n) => canonicalizeAppDefinition(aiStepDef({ kind: 'ai_generate', prompt: 'p'.repeat(n), resultVar: 'r' }));
    assert.equal(run(32000).def.actions.act_ai0001.steps[0].prompt.length, 32000);
    const cut = run(32001);
    assert.equal(cut.def.actions.act_ai0001.steps[0].prompt.length, 32000);
    assert.ok(codes(cut.repairs).has('string.truncated'));
});
