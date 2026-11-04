/**
 * Definition limits: raised ceilings (200 actions, nesting 8) and messages that name the limit and the value.
 *
 * Run: cd server && node --test appStudio/validate.limits.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('./validate');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { LIMITS, SECTION_STYLE_DEFAULTS } = require('./componentSpecs');

const has = (recs, code) => recs.some((r) => r.code === code);

// A heading nested under `cards` cards: depth = section(1) + cards + the heading.
function nestedCards(cards) {
    let node = { id: 'cmp_deepleaf', type: 'heading', props: { text: 'x' } };
    for (let i = cards; i >= 1; i--) node = { id: `cmp_deep${String(i).padStart(2, '0')}`, type: 'card', props: {}, children: [node] };
    return [node];
}

function appWith({ cards = 0, actions = 0, steps } = {}) {
    const def = {
        schemaVersion: 2,
        meta: { name: 'Limits' },
        theme: {},
        homeScreenId: 'scr_main01',
        screens: [{ id: 'scr_main01', name: 'Home', sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: nestedCards(cards) }] }],
        actions: Object.fromEntries(Array.from({ length: actions }, (_, i) => [`act_pad${String(i).padStart(4, '0')}`, { kind: 'toast', message: `m${i}` }])),
    };
    if (steps) def.actions.act_seq0001 = { kind: 'sequence', steps };
    return canonicalizeAppDefinition(def).def;
}

test('an app with 61 actions and nesting 8 is valid', () => {
    assert.equal(LIMITS.MAX_DEPTH, 8);
    // section + 6 nested cards + heading = depth 8.
    const res = validateAppDefinition(appWith({ cards: 6, actions: 61 }));
    assert.ok(!has(res.errors, 'shape.too_many_actions'), JSON.stringify(res.errors));
    assert.ok(!has(res.errors, 'shape.too_deep'), JSON.stringify(res.errors));
    assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
});

test('nesting 9 is refused and the message names 9 and 8', () => {
    const res = validateAppDefinition(appWith({ cards: 7 }));
    assert.match(res.errors.find((e) => e.code === 'shape.too_deep').message, /9 levels.*maximum is 8/);
});

test('200 actions are valid, 201 are refused with count and maximum', () => {
    assert.ok(!has(validateAppDefinition(appWith({ actions: LIMITS.MAX_ACTIONS })).errors, 'shape.too_many_actions'));
    const over = validateAppDefinition(appWith({ actions: LIMITS.MAX_ACTIONS + 1 }));
    assert.match(over.errors.find((e) => e.code === 'shape.too_many_actions').message, /has 201 actions — the maximum is 200/);
});

test('a sequence nested 8 levels is valid, 9 says "reaches level 9 — the maximum is 8"', () => {
    const nest = (levels) => {
        let steps = [{ kind: 'toast', message: 'leaf' }];
        for (let i = 1; i < levels; i++) steps = [{ kind: 'condition', expr: 'true', then: steps, else: [] }];
        return steps;
    };
    assert.ok(!has(validateAppDefinition(appWith({ steps: nest(8) })).errors, 'action.step_too_deep'));
    const res = validateAppDefinition(appWith({ steps: nest(9) }));
    assert.match(res.errors.find((e) => e.code === 'action.step_too_deep').message, /reaches level 9 — the maximum is 8/);
});
