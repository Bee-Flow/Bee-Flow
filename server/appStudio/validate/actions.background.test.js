/**
 * Background sequences in the canonicalizer and the validator: the run options survive a
 * save, a sequence without them is unchanged, and every error and warning of
 * validate/backgroundChecks.mts fires where it should (and nowhere in the shipped templates).
 *
 * Run: cd server && node --test appStudio/validate/actions.background.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { SECTION_STYLE_DEFAULTS } = require('../componentSpecs');

const codes = (recs, code) => recs.filter((r) => r.code === code);

function app(actions, rootId = 'act_main01') {
    return {
        schemaVersion: 2,
        meta: { name: 'Background' },
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

const gen = { kind: 'ai_generate', prompt: 'Summarise', resultVar: 'summary' };
const status = (text) => ({ kind: 'set_variable', name: 'status', value: { kind: 'static', value: text } });

function check(actions) {
    return validateAppDefinition(canonicalizeAppDefinition(app(actions)).def);
}

test('canonicalize keeps background / lockKey / progressVar, and a plain sequence is unchanged', () => {
    const lockKey = { kind: 'formula', expr: "'order:' + form.id" };
    const { def: definition } = canonicalizeAppDefinition(app({
        act_main01: { kind: 'sequence', steps: [status('go'), gen], background: true, lockKey, progressVar: 'status' },
        act_plain1: { kind: 'sequence', steps: [gen] },
    }));
    const bg = definition.actions.act_main01;
    assert.equal(bg.background, true);
    assert.deepEqual(bg.lockKey, lockKey);
    assert.equal(bg.progressVar, 'status');
    const plain = definition.actions.act_plain1;
    assert.deepEqual(Object.keys(plain), ['kind', 'steps'], 'no option keys appear, not even as undefined');
    assert.ok(!('background' in plain));
});

test('canonicalize drops a non-boolean background with a note, and never writes undefined', () => {
    const { def: definition, repairs } = canonicalizeAppDefinition(app({ act_main01: { kind: 'sequence', steps: [gen], background: 'yes' } }));
    assert.ok(!('background' in definition.actions.act_main01));
    assert.ok((repairs || []).some((r) => r.code === 'action.field_invalid' && /background/.test(r.path)), JSON.stringify(repairs));
});

test('a valid background sequence has no background errors', () => {
    const r = check({ act_main01: { kind: 'sequence', background: true, progressVar: 'status', lockKey: { kind: 'formula', expr: "'x:' + form.id" }, steps: [
        { kind: 'confirm', message: 'Start?' }, status('working'), gen, { kind: 'toast', message: 'Done' }, { kind: 'refresh' },
    ] } });
    assert.deepEqual(r.errors.filter((e) => /background/.test(e.code)), []);
    assert.deepEqual(r.warnings.filter((e) => /background|progress_var|lock_without/.test(e.code)), []);
});

test('a browser-only step in a background sequence is an error, also inside a branch and a callee', () => {
    const r = check({
        act_main01: { kind: 'sequence', background: true, steps: [
            gen,
            { kind: 'condition', expr: 'true', then: [{ kind: 'navigate', screenId: 'scr_main01' }], else: [] },
            { kind: 'call_action', actionId: 'act_help01' },
        ] },
        act_help01: { kind: 'sequence', steps: [{ kind: 'open_url', url: 'https://example.com' }] },
    });
    const errs = codes(r.errors, 'action.background_step_unsupported');
    assert.equal(errs.length, 2, JSON.stringify(errs));
    assert.ok(errs.some((e) => e.path.endsWith('steps[1].then[0]')));
    assert.ok(errs.some((e) => e.path.endsWith('steps[2].call.steps[0]')));
});

test('a confirm after the first step is an error; a leading one is fine', () => {
    const r = check({ act_main01: { kind: 'sequence', background: true, steps: [gen, { kind: 'confirm', message: 'Sure?' }] } });
    assert.equal(codes(r.errors, 'action.background_confirm_position').length, 1);
});

test('warnings: lockKey without background, a progressVar nobody writes, a background callee', () => {
    const r = check({
        act_main01: { kind: 'sequence', steps: [gen, { kind: 'call_action', actionId: 'act_bg0001' }], lockKey: { kind: 'formula', expr: 'form.id' } },
        act_bg0001: { kind: 'sequence', background: true, progressVar: 'nobody', steps: [gen] },
    });
    assert.equal(codes(r.warnings, 'action.lock_without_background').length, 1);
    assert.equal(codes(r.warnings, 'action.progress_var_unknown').length, 1);
    assert.equal(codes(r.warnings, 'action.background_in_called_action').length, 1);
});

test('a malformed progressVar is an error', () => {
    const r = check({ act_main01: { kind: 'sequence', background: true, progressVar: 'not a name', steps: [gen] } });
    assert.ok(codes(r.errors, 'action.field_invalid').some((e) => e.path.endsWith('progressVar')));
});
