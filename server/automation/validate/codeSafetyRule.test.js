'use strict';

/**
 * The validator reads a code step's source with automation/codeSafety: a
 * BLOCK finding or a syntax error saves as a draft and refuses activation
 * (`code.safety_blocked`), because the runner would refuse every run of it.
 *
 * Run: node --test automation/validate/codeSafetyRule.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('../validate');

const def = (code) => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [{ id: 'c1', type: 'code', language: 'javascript', code }],
    edges: [{ from: 'trg', to: 'c1' }],
});
const codes = (d, stage) => {
    const r = validateDefinition(d, { stage });
    return { errors: (r.errors || []).map((e) => e.code), all: [...(r.errors || []), ...(r.warnings || [])] };
};

test('blocked code saves as a draft and refuses activation, with the plain reason', () => {
    const d = def('return eval("1");');
    assert.ok(!codes(d, 'draft').errors.includes('code.safety_blocked'), 'a draft still saves');
    const act = codes(d, 'activate');
    assert.ok(act.errors.includes('code.safety_blocked'));
    const issue = act.all.find((e) => e.code === 'code.safety_blocked');
    assert.match(issue.message, /line 1: Code that writes and runs new code cannot be checked/);
});

test('a syntax error is refused at activation too', () => {
    const act = codes(def('return {;'), 'activate');
    assert.ok(act.errors.includes('code.safety_blocked'));
});

test('ordinary code, and code with only warnings, activates', () => {
    assert.ok(!codes(def('return inputs.items.map((i) => i.total);'), 'activate').errors.includes('code.safety_blocked'));
    assert.ok(!codes(def('Object.prototype.x = 1; return 1;'), 'activate').errors.includes('code.safety_blocked'));
});
