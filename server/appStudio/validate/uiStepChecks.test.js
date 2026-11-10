/**
 * The browser steps of schema 3 (componentSpecs/steps: set_form_field, focus, scroll_to,
 * copy_to_clipboard, set_ui, back, wait) and the client-only scope root `ui`: what the
 * canonicalizer keeps, what the validator says (uiStepChecks.mts, clientOnlyRoots.mts), and
 * that every server-side execution form keeps them out exactly like navigate.
 *
 * Run: cd server && node --test appStudio/validate/uiStepChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { SECTION_STYLE_DEFAULTS, LIMITS } = require('../componentSpecs');
const { STEP_POLICY_LISTS, stepPolicy } = require('../componentSpecs/stepRegistry');

const UI_KINDS = ['back', 'copy_to_clipboard', 'focus', 'scroll_to', 'set_form_field', 'set_ui', 'wait'];

const codes = (recs, code) => recs.filter((r) => r.code === code);
const stat = (value) => ({ kind: 'static', value });

function app(actions) {
    return {
        schemaVersion: 3,
        meta: { name: 'UI steps' },
        theme: {},
        homeScreenId: 'scr_main01',
        screens: [{
            id: 'scr_main01', name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [
                { id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: 'act_main01' },
                { id: 'cmp_form01', type: 'form', props: { name: 'order' }, children: [
                    { id: 'cmp_qty001', type: 'input_number', props: { name: 'quantity', label: 'Quantity' } },
                ] },
                { id: 'cmp_tabs01', type: 'tabs', props: {}, children: [
                    { id: 'cmp_tab_a1', type: 'tab', props: { label: 'A' }, children: [] },
                    { id: 'cmp_tab_b1', type: 'tab', props: { label: 'B' }, children: [] },
                ] },
                { id: 'cmp_modal1', type: 'modal', props: { title: 'Details' }, children: [] },
                { id: 'cmp_grid01', type: 'data_grid', props: { selectable: 'multi' } },
                { id: 'cmp_grid02', type: 'data_grid', props: {} },
            ] }],
        }],
        actions,
    };
}

function check(steps, extraActions = {}) {
    const { def } = canonicalizeAppDefinition(app({ act_main01: { kind: 'sequence', steps }, ...extraActions }));
    return { def, ...validateAppDefinition(def) };
}

const ALL_STEPS = [
    { kind: 'set_form_field', form: 'order', field: 'quantity', value: stat(3) },
    { kind: 'focus', nodeId: 'cmp_qty001' },
    { kind: 'scroll_to', nodeId: 'top' },
    { kind: 'scroll_to', nodeId: 'cmp_grid01' },
    { kind: 'copy_to_clipboard', text: { kind: 'formula', expr: "'ref-' + vars.n" } },
    { kind: 'set_ui', nodeId: 'cmp_tabs01', state: 'activeTab', value: stat('cmp_tab_b1') },
    { kind: 'set_ui', nodeId: 'cmp_modal1', state: 'open', value: stat(true) },
    { kind: 'set_ui', nodeId: 'cmp_grid01', state: 'selection', value: stat([]) },
    { kind: 'back' },
    { kind: 'wait', seconds: 2 },
];

test('every new browser step survives a save unchanged and validates without a finding of its own', () => {
    const { def, errors, warnings } = check(ALL_STEPS);
    assert.deepEqual(def.actions.act_main01.steps, ALL_STEPS);
    const mine = (r) => /set_ui|step_node|set_form_field|client_root/.test(r.code);
    assert.deepEqual(errors.filter(mine), []);
    assert.deepEqual(warnings.filter(mine), []);
    assert.deepEqual(errors.filter((e) => e.path.startsWith('actions.')), [], JSON.stringify(errors));
});

test('a wait longer than the browser holds is invalid, and the limit is the shared constant', () => {
    assert.equal(LIMITS.MAX_CLIENT_WAIT_SECONDS, 30);
    const { errors } = check([{ kind: 'wait', seconds: LIMITS.MAX_CLIENT_WAIT_SECONDS + 1 }]);
    assert.ok(errors.some((e) => e.path.includes('steps[0]') && /seconds/.test(`${e.path} ${e.message}`)), JSON.stringify(errors));
});

test('a required field left out is an error', () => {
    const { errors } = check([{ kind: 'set_ui', nodeId: 'cmp_tabs01', state: 'activeTab' }, { kind: 'focus' }]);
    assert.ok(errors.some((e) => e.path.includes('steps[0]')), JSON.stringify(errors));
    assert.ok(errors.some((e) => e.path.includes('steps[1]')), JSON.stringify(errors));
});

test('set_ui on a component that does not keep that state is an error; a grid without selection a warning', () => {
    const { errors, warnings } = check([
        { kind: 'set_ui', nodeId: 'cmp_modal1', state: 'activeTab', value: stat(0) },
        { kind: 'set_ui', nodeId: 'cmp_grid02', state: 'selection', value: stat('r1') },
    ]);
    const mismatch = codes(errors, 'action.set_ui_state_mismatch');
    assert.equal(mismatch.length, 1, JSON.stringify(errors));
    assert.ok(mismatch[0].path.endsWith('steps[0].state'));
    assert.equal(codes(warnings, 'action.set_ui_grid_not_selectable').length, 1);
});

test('a node, form or field that is not in the app is a warning, never an error', () => {
    const { errors, warnings } = check([
        { kind: 'focus', nodeId: 'cmp_nope01' },
        { kind: 'scroll_to', nodeId: 'cmp_nope02' },
        { kind: 'set_form_field', form: 'nope', field: 'x', value: stat(1) },
        { kind: 'set_form_field', form: 'order', field: 'nope', value: stat(1) },
    ]);
    assert.equal(codes(warnings, 'action.step_node_unresolved').length, 2);
    assert.equal(codes(warnings, 'action.set_form_field_unknown_form').length, 1);
    assert.equal(codes(warnings, 'action.set_form_field_unknown_field').length, 1);
    assert.deepEqual(errors.filter((e) => /step_node|set_form_field/.test(e.code)), []);
});

test('the ui root is a known root in a browser formula, and a warning in a server step', () => {
    const { warnings } = check([
        { kind: 'condition', expr: 'count(ui.selection.cmp_grid01) > 0', then: [], else: [] },
        { kind: 'set_variable', name: 'picked', value: { kind: 'formula', expr: 'ui.tabs.cmp_tabs01.active' } },
        { kind: 'create_record', tableId: 'tbl_orders', values: { picked: { kind: 'formula', expr: 'ui.selection.cmp_grid01' } } },
    ]);
    assert.deepEqual(codes(warnings, 'unknown_formula_root').filter((w) => /"ui"/.test(w.message)), []);
    const server = codes(warnings, 'formula.server_scope_client_root');
    assert.ok(server.length >= 1, JSON.stringify(warnings));
    assert.ok(server.every((w) => w.path.includes('steps[2]')), JSON.stringify(server));
});

test('every server-side execution form keeps the browser steps out, exactly like navigate', () => {
    for (const kind of UI_KINDS) {
        for (const form of ['click', 'background', 'mailboxHook', 'unattended', 'mcpRun', 'mcpDryRun', 'public']) {
            assert.equal(stepPolicy(kind, form), stepPolicy('navigate', form), `${kind}.${form}`);
        }
        assert.ok(STEP_POLICY_LISTS.backgroundRefusedKinds.includes(kind), `background refuses ${kind}`);
        assert.ok(!STEP_POLICY_LISTS.hookStepKinds.includes(kind) && !STEP_POLICY_LISTS.hookControlKinds.includes(kind), `mailbox hook refuses ${kind}`);
        assert.ok(!STEP_POLICY_LISTS.mcpLiveKinds.includes(kind), `app_run_action skips ${kind}`);
    }
});

test('a background sequence with a browser step is refused at save', () => {
    const { def } = canonicalizeAppDefinition(app({ act_main01: { kind: 'sequence', background: true, steps: [{ kind: 'ai_generate', prompt: 'Hi', resultVar: 'x' }, { kind: 'wait', seconds: 3 }, { kind: 'set_ui', nodeId: 'cmp_modal1', state: 'open', value: stat(false) }] } }));
    const errs = codes(validateAppDefinition(def).errors, 'action.background_step_unsupported');
    assert.equal(errs.length, 2, JSON.stringify(errs));
});
