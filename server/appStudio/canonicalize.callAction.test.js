'use strict';

/**
 * Canonicalizer: call_action params and modelTier as a tier name or a binding.
 * Run: cd server && node --test appStudio/canonicalize.callAction.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { SECTION_STYLE_DEFAULTS } = require('./componentSpecs');

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


test('call_action params: trimmed names, bindings cleaned, past 20 dropped with a note; a non-object is reset', () => {
    const many = {};
    for (let i = 0; i < 22; i++) many[`p${i}`] = { kind: 'static', value: i };
    const { def, repairs } = canonicalizeAppDefinition(wrap([], { actions: {
        act_main01: { kind: 'sequence', steps: [
            { kind: 'call_action', actionId: 'act_calc01', params: { ' n ': { kind: 'static', value: 2 } }, resultVar: 'calc' },
            { kind: 'call_action', actionId: 'act_calc01', params: many },
            { kind: 'call_action', actionId: 'act_calc01', params: 'nope' },
        ] },
        act_calc01: { kind: 'call_action', actionId: 'act_main01', params: { q: { kind: 'formula', expr: 'form.q' } } },
    } }));
    const [a, b, c] = def.actions.act_main01.steps;
    assert.deepEqual(a, { kind: 'call_action', actionId: 'act_calc01', params: { n: { kind: 'static', value: 2 } }, resultVar: 'calc' });
    assert.equal(Object.keys(b.params).length, 20);
    assert.deepEqual(c.params, {});
    assert.ok(repairs.some((r) => /maximum is 20/.test(r.message)), JSON.stringify(repairs));
    assert.ok(repairs.some((r) => /trimmed/.test(r.message)));
    assert.deepEqual(def.actions.act_calc01.params, { q: { kind: 'formula', expr: 'form.q' } }, 'the bare action keeps its params');
    const again = canonicalizeAppDefinition(def);
    assert.deepEqual(again.repairs, []);
    assert.equal(JSON.stringify(again.def), JSON.stringify(def));
});

test('modelTier: a tier name as before, a formula or static binding kept, anything else dropped with a note', () => {
    const step = (modelTier) => ({ kind: 'ai_generate', prompt: 'p', output: 'text', resultVar: 'r', modelTier });
    const { def, repairs } = canonicalizeAppDefinition(wrap([], { actions: {
        act_main01: { kind: 'sequence', steps: [
            step('fast'),
            step({ kind: 'formula', expr: "params.quick ? 'fast' : 'thinking'", extra: 1 }),
            step({ kind: 'static', value: 'thinking' }),
            step(42),
        ] },
        act_bare01: { kind: 'ai_generate', prompt: 'p', output: 'text', resultVar: 'r', modelTier: { kind: 'formula', expr: 'vars.tier' } },
    } }));
    const tiers = def.actions.act_main01.steps.map((s) => s.modelTier);
    assert.deepEqual(tiers, ['fast', { kind: 'formula', expr: "params.quick ? 'fast' : 'thinking'" }, { kind: 'static', value: 'thinking' }, undefined]);
    assert.ok(repairs.some((r) => /modelTier must be a tier name/.test(r.message)));
    assert.deepEqual(def.actions.act_bare01.modelTier, { kind: 'formula', expr: 'vars.tier' });
    const again = canonicalizeAppDefinition(def);
    assert.deepEqual(again.repairs, []);
});
