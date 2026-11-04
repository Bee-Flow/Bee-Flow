/**
 * call_action in the validator: target, params, cycles, depth, reachability and
 * send_email in a loop through a call.
 *
 * Run: cd server && node --test appStudio/validate/callChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { SECTION_STYLE_DEFAULTS } = require('../componentSpecs');

const codes = (recs, code) => recs.filter((r) => r.code === code);

/** An app whose one button runs `rootId`; `actions` as given. */
function app(actions, rootId = 'act_main01') {
    return {
        schemaVersion: 2,
        meta: { name: 'Calls' },
        theme: {},
        homeScreenId: 'scr_main01',
        screens: [{
            id: 'scr_main01', name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [
                { id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: rootId },
            ] }],
        }],
        actions,
    };
}

const call = (actionId, params) => ({ kind: 'call_action', actionId, ...(params ? { params } : {}) });
const seq = (...steps) => ({ kind: 'sequence', steps });
const toast = { kind: 'toast', message: 'hi' };

function check(actions, rootId) {
    return validateAppDefinition(canonicalizeAppDefinition(app(actions, rootId)).def);
}

test('a valid call: no errors, and the callee reached only through the call is not unreachable', () => {
    const res = check({ act_main01: seq(call('act_calc01', { n: { kind: 'static', value: 2 } })), act_calc01: seq(toast) });
    assert.deepEqual(res.errors, []);
    assert.equal(codes(res.warnings, 'action.unreachable').length, 0, JSON.stringify(res.warnings));
});

test('the callees of an unreachable action stay unreachable', () => {
    const res = check({ act_main01: seq(toast), act_lone01: seq(call('act_calc01')), act_calc01: seq(toast) });
    const ids = codes(res.warnings, 'action.unreachable').map((w) => w.path).sort();
    assert.deepEqual(ids, ['actions.act_calc01', 'actions.act_lone01']);
});

test('spec: a cycle act_a → act_b → act_a is rejected', () => {
    const res = check({ act_main01: seq(call('act_bbbb01')), act_bbbb01: seq(call('act_main01')) });
    const [cycle] = codes(res.errors, 'action.call_cycle');
    assert.ok(cycle, JSON.stringify(res.errors));
    assert.match(cycle.message, /act_bbbb01 → act_main01 → act_bbbb01: an action may not call itself, directly or through others/);
    assert.equal(codes(res.errors, 'action.call_cycle').length, 1, 'each cycle once');
});

test('a self-call is a cycle too', () => {
    const res = check({ act_main01: seq(toast, call('act_main01')) });
    assert.match(codes(res.errors, 'action.call_cycle')[0].message, /act_main01 → act_main01/);
});

test('a bare call_action action is checked like the step', () => {
    const res = check({ act_main01: call('act_nope01') });
    const [e] = codes(res.errors, 'action.call_target_unknown');
    assert.ok(e, JSON.stringify(res.errors));
    assert.equal(e.path, 'actions.act_main01.actionId');
});

test('an unknown target names the closest id', () => {
    const res = check({ act_main01: seq(call('act_calc02')), act_calc01: seq(toast) });
    const [e] = codes(res.errors, 'action.call_target_unknown');
    assert.match(e.message, /act_calc02/);
    assert.match(e.hint, /act_calc01/);
});

test('three calls deep is valid, four is rejected naming the maximum 3', () => {
    const chain = (n) => {
        const ids = Array.from({ length: n + 1 }, (_, i) => `act_lvl${i}xx`);
        return Object.fromEntries(ids.map((id, i) => [i === 0 ? 'act_main01' : id, i < n ? seq(call(ids[i + 1])) : seq(toast)]));
    };
    assert.deepEqual(codes(check(chain(3)).errors, 'action.call_too_deep'), []);
    const [deep] = codes(check(chain(4)).errors, 'action.call_too_deep');
    assert.ok(deep);
    assert.match(deep.message, /is 4 calls deep; the maximum is 3/);
    assert.match(deep.message, /^act_main01 → /);
});

test('params: a bad name and too many entries are refused, each value is a binding', () => {
    const bad = check({ act_main01: seq(call('act_calc01', { 'two words': { kind: 'static', value: 1 } })), act_calc01: seq(toast) });
    assert.ok(codes(bad.errors, 'action.call_param_invalid').length, JSON.stringify(bad.errors));
    const many = {};
    for (let i = 0; i < 21; i++) many[`p${i}`] = { kind: 'static', value: i };
    // The canonicalizer keeps 20 (with a note); the raw definition still fails validation.
    const raw = validateAppDefinition(app({ act_main01: seq(call('act_calc01', many)), act_calc01: seq(toast) }));
    assert.match(codes(raw.errors, 'action.call_param_invalid')[0].message, /21 entries — the maximum is 20/);
    const badBinding = check({ act_main01: seq(call('act_calc01', { n: { kind: 'formula', expr: '1 +' } })), act_calc01: seq(toast) });
    assert.ok(badBinding.errors.length, 'the value goes through the binding validator');
});

test('a param the callee reads but the call does not pass is a warning', () => {
    const callee = seq({ kind: 'set_variable', name: 'out', value: { kind: 'formula', expr: "params.name + ' ' + params.size" } });
    const res = check({ act_main01: seq(call('act_calc01', { name: { kind: 'static', value: 'x' } })), act_calc01: callee });
    const [w] = codes(res.warnings, 'action.call_param_missing');
    assert.ok(w, JSON.stringify(res.warnings));
    assert.match(w.message, /params\.size/);
    assert.doesNotMatch(w.message, /params\.name/);
    assert.equal(w.path, 'actions.act_main01.steps[0].params');
});

test('a loop that calls an action which sends email is send_email_in_loop', () => {
    const sender = seq({ kind: 'send_email', to: { kind: 'static', value: 'a@example.com' }, subject: 's', body: 'b' });
    const res = check({
        act_main01: seq({ kind: 'loop', source: { kind: 'static', value: [1, 2] }, steps: [call('act_send01')] }),
        act_send01: sender,
    });
    assert.ok(codes(res.errors, 'action.send_email_in_loop').length, JSON.stringify(res.errors));
});

test('a definition without call_action gives the same findings as before (no call codes)', () => {
    const res = check({ act_main01: seq(toast, { kind: 'loop', source: { kind: 'static', value: [1] }, steps: [toast] }) });
    assert.deepEqual(res.errors, []);
    assert.equal(res.warnings.filter((w) => w.code.startsWith('action.call_')).length, 0);
});
