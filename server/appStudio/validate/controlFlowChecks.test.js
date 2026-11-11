/**
 * The control-flow step kinds in the validator, the canonicalizer and the schema version:
 * return, break, continue, while, raise_error, try. A definition without them validates,
 * canonicalizes and is versioned exactly as before.
 *
 * Run: cd server && node --test appStudio/validate/controlFlowChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { SECTION_STYLE_DEFAULTS } = require('../componentSpecs');
const { hookActionProblems } = require('../mailboxHookPolicy.mts');

const codes = (recs, code) => recs.filter((r) => r.code === code);

function app(steps, more = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'Flow' },
        theme: {},
        homeScreenId: 'scr_main01',
        variables: [{ name: 'n', type: 'number', default: 0 }, { name: 'why', type: 'text', default: '' }],
        screens: [{
            id: 'scr_main01', name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [
                { id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: 'act_main01' },
            ] }],
        }],
        actions: { act_main01: { kind: 'sequence', steps }, ...more },
    };
}
const validate = (steps, more) => validateAppDefinition(app(steps, more), {});
const setVar = (name, expr) => ({ kind: 'set_variable', name, value: { kind: 'formula', expr } });
const toast = { kind: 'toast', message: 'x', tone: 'info' };
const mail = { kind: 'send_email', connectorId: 'con_mail01', to: { kind: 'static', value: 'a@example.org' }, subject: { kind: 'static', value: 's' }, body: { kind: 'static', value: 'b' }, replyToRecordId: { kind: 'static', value: 'r' } };

const FULL = [
    { kind: 'while', expr: 'vars.n < 3', maxIterations: 10, steps: [
        setVar('n', 'vars.n + 1'),
        { kind: 'condition', expr: 'vars.n == 2', then: [{ kind: 'continue' }], else: [] },
        { kind: 'try', steps: [{ kind: 'condition', expr: 'vars.n > 5', then: [{ kind: 'break' }], else: [] }], finally: [toast] },
    ] },
    { kind: 'try', steps: [{ kind: 'raise_error', message: { kind: 'formula', expr: '"Too many: " + vars.n' }, code: 'too_many' }], catch: [setVar('why', 'error.message')], finally: [toast] },
    { kind: 'condition', expr: 'vars.n > 0', then: [{ kind: 'return', value: { kind: 'formula', expr: 'vars.n' } }], else: [] },
    { kind: 'return' },
];

test('every control kind validates clean, and canonicalizes to itself with schemaVersion 3', () => {
    const once = canonicalizeAppDefinition(app(FULL));
    assert.deepEqual(validateAppDefinition(once.def, {}).errors, []);
    assert.equal(once.def.schemaVersion, 3);
    assert.deepEqual(once.def.actions.act_main01.steps, FULL, 'nothing added, nothing dropped');
    const twice = canonicalizeAppDefinition(JSON.parse(JSON.stringify(once.def)));
    assert.equal(JSON.stringify(twice.def), JSON.stringify(once.def), 'a second pass changes nothing');
});

test('a definition without them keeps schemaVersion 2', () => {
    const def = canonicalizeAppDefinition(app([toast, { kind: 'loop', source: { kind: 'static', value: [] }, steps: [toast] }])).def;
    assert.equal(def.schemaVersion, 2);
});

test('optional fields stay absent: no default is written into a control step', () => {
    const def = canonicalizeAppDefinition(app([{ kind: 'while', expr: 'false', steps: [] }, { kind: 'try', steps: [] }, { kind: 'return' }, { kind: 'raise_error', message: { kind: 'static', value: 'x' } }])).def;
    assert.deepEqual(def.actions.act_main01.steps, [{ kind: 'while', expr: 'false', steps: [] }, { kind: 'try', steps: [] }, { kind: 'return' }, { kind: 'raise_error', message: { kind: 'static', value: 'x' } }]);
});

test('break and continue outside a loop or while are errors; inside a condition, try or handler of a loop body they are fine', () => {
    const bad = validate([{ kind: 'break' }, { kind: 'condition', expr: 'true', then: [{ kind: 'continue' }], else: [] }, { kind: 'try', steps: [toast], catch: [{ kind: 'break' }] }]);
    assert.deepEqual(codes(bad.errors, 'action.step_outside_loop').map((e) => e.path), ['actions.act_main01.steps[0]', 'actions.act_main01.steps[1].then[0]', 'actions.act_main01.steps[2].catch[0]']);
    const good = validate([{ kind: 'loop', source: { kind: 'static', value: [1] }, steps: [
        { kind: 'switch', expr: 'item', cases: [{ value: 1, steps: [{ kind: 'continue' }] }], default: [{ kind: 'break' }] },
        { kind: 'try', steps: [toast], catch: [{ kind: 'break' }], finally: [{ kind: 'continue' }] },
        { kind: 'ai_generate', prompt: 'p', resultVar: 'r', onError: { steps: [{ kind: 'break' }] } },
    ] }]);
    assert.deepEqual(codes(good.errors, 'action.step_outside_loop'), []);
});

test('a loop in the caller does not make a break in the called action legal', () => {
    const res = validate([{ kind: 'loop', source: { kind: 'static', value: [1] }, steps: [{ kind: 'call_action', actionId: 'act_sub001' }] }], { act_sub001: { kind: 'sequence', steps: [{ kind: 'break' }] } });
    assert.deepEqual(codes(res.errors, 'action.step_outside_loop').map((e) => e.path), ['actions.act_sub001.steps[0]']);
});

test('while: expr and steps are required, maxIterations is 1..200, unknown fields are refused', () => {
    const res = validate([{ kind: 'while' }, { kind: 'while', expr: 'vars.n <', steps: [], maxIterations: 201 }, { kind: 'while', expr: 'true', steps: [], itemVar: 'x' }]);
    const required = codes(res.errors, 'action.step_field_required').map((e) => e.path);
    assert.deepEqual(required, ['actions.act_main01.steps[0].expr', 'actions.act_main01.steps[0].steps']);
    assert.ok(res.errors.some((e) => e.path === 'actions.act_main01.steps[1].maxIterations' && e.code === 'action.step_field_invalid'));
    assert.ok(res.errors.some((e) => e.path === 'actions.act_main01.steps[1].expr'), 'a formula that does not compile is named');
    assert.ok(codes(res.errors, 'action.step_unknown_field').some((e) => e.path === 'actions.act_main01.steps[2].itemVar'));
});

test('send_email may not sit inside a while, directly, in a try inside it, or through a call', () => {
    const direct = validate([{ kind: 'while', expr: 'true', steps: [{ kind: 'try', steps: [toast], catch: [mail] }] }]);
    assert.equal(codes(direct.errors, 'action.send_email_in_loop').length, 1);
    const called = validate([{ kind: 'while', expr: 'true', steps: [{ kind: 'call_action', actionId: 'act_sub001' }] }], { act_sub001: { kind: 'sequence', steps: [mail] } });
    assert.equal(codes(called.errors, 'action.send_email_in_loop').length, 1);
    // The base loop sees a mail hidden in a try's catch as well.
    const inLoop = validate([{ kind: 'loop', source: { kind: 'static', value: [1] }, steps: [{ kind: 'try', steps: [toast], finally: [mail] }] }]);
    assert.equal(codes(inLoop.errors, 'action.send_email_in_loop').length, 1);
});

test('raise_error needs a message; try warns when it can do nothing', () => {
    const res = validate([{ kind: 'raise_error' }, { kind: 'try', steps: [toast] }, { kind: 'try', steps: [], catch: [] }]);
    assert.ok(codes(res.errors, 'action.step_field_required').some((e) => e.path === 'actions.act_main01.steps[0].message'));
    assert.deepEqual(codes(res.warnings, 'action.try_plain').map((w) => w.path), ['actions.act_main01.steps[1]']);
    assert.deepEqual(codes(res.warnings, 'action.try_empty').map((w) => w.path), ['actions.act_main01.steps[2].steps']);
});

test('the step count and the nesting ceiling see the steps of the new containers', () => {
    let nested = [toast];
    for (let i = 0; i < 9; i += 1) nested = [{ kind: 'try', steps: nested }];
    assert.equal(codes(validate(nested).errors, 'action.step_too_deep').length, 1);
    const many = validate([{ kind: 'try', steps: Array.from({ length: 70 }, () => toast), catch: Array.from({ length: 70 }, () => toast) }]);
    assert.ok(many.errors.some((e) => /too many steps|step/i.test(e.message) && e.code.includes('too_many')), 'catch steps count');
});

test('the mailbox hook runs try, return and raise_error but never a while', () => {
    assert.deepEqual(hookActionProblems({ kind: 'sequence', steps: [{ kind: 'try', steps: [{ kind: 'create_record' }], catch: [{ kind: 'raise_error' }], finally: [{ kind: 'return' }] }] }, 'act_a'), []);
    const refused = hookActionProblems({ kind: 'sequence', steps: [{ kind: 'while', expr: 'true', steps: [{ kind: 'create_record' }] }] }, 'act_a');
    assert.equal(refused.length, 1);
    assert.match(refused[0], /"while" step, which cannot run unattended/);
    const hidden = hookActionProblems({ kind: 'sequence', steps: [{ kind: 'try', steps: [], finally: [{ kind: 'send_email' }] }] }, 'act_a');
    assert.match(hidden[0], /send_email/);
});
