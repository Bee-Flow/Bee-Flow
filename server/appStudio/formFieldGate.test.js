'use strict';

/**
 * Submitted form values against the form's role gates (appStudio/formFieldGate.mts, bound to a
 * role by routes/studioAppRunGate.js visibleFormValues).
 *
 * Run: cd server && node --test appStudio/formFieldGate.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { gatedFormFieldNames, withoutGatedFormFields } = require('./formFieldGate.mts');
const { visibleFormValues, roleAllows } = require('../routes/studioAppRunGate');

const input = (name, extra = {}) => ({ id: `in_${name}_${Math.random().toString(36).slice(2, 6)}`, type: 'input_text', props: { name }, ...extra });
const form = (children, extra = {}) => ({ id: 'frm', type: 'form', props: { name: 'request' }, onSubmit: 'act_save', children, ...extra });
const defOf = (children, actions = {}, screen = {}) => ({ screens: [{ id: 'scr_1', ...screen, sections: [{ id: 'sec_1', children }] }], actions });
const as = (role) => (node) => roleAllows(node, role);

const VALUES = Object.freeze({ title: 'Laptop', amount: 1200, approvedBy: 'someone' });

test('a form without a gated field gives the bag back untouched, for every role', () => {
    const def = defOf([form([input('title'), input('amount'), input('approvedBy')])]);
    for (const role of ['member', 'admin', null, 'owner', 'public']) {
        assert.equal(visibleFormValues(def, 'act_save', role, VALUES), VALUES, `same object for ${role}`);
    }
    assert.equal(gatedFormFieldNames(def, 'act_save', as('member')).size, 0);
});

test('a definition without forms, screens or actions changes nothing', () => {
    for (const def of [null, undefined, {}, { screens: 'x' }, defOf([{ id: 'b', type: 'button', onClick: 'act_save' }])]) {
        assert.equal(visibleFormValues(def, 'act_save', 'member', VALUES), VALUES);
    }
});

test('the value of a field gated away from the role is left out; the rest stays', () => {
    const def = defOf([form([input('title'), input('amount'), input('approvedBy', { visibleToRoles: ['admin'] })])]);
    assert.deepEqual(visibleFormValues(def, 'act_save', 'member', VALUES), { title: 'Laptop', amount: 1200 });
    assert.deepEqual(visibleFormValues(def, 'act_save', null, VALUES), { title: 'Laptop', amount: 1200 }, 'a viewer without a role clears open gates only');
    assert.equal(visibleFormValues(def, 'act_save', 'admin', VALUES), VALUES, 'the named role submits it');
    assert.equal(visibleFormValues(def, 'act_save', 'owner', VALUES), VALUES, 'the owner submits everything');
});

test('a gate on a container inside the form covers the fields under it', () => {
    const tabs = { id: 'tabs', type: 'tabs', props: {}, children: [
        { id: 'tab_a', type: 'tab', props: { label: 'Request' }, children: [input('title')] },
        { id: 'tab_b', type: 'tab', props: { label: 'Review' }, visibleToRoles: ['admin'], children: [{ id: 'box', type: 'container', props: {}, children: [input('approvedBy')] }] },
    ] };
    const def = defOf([form([tabs, input('amount')])]);
    assert.deepEqual(visibleFormValues(def, 'act_save', 'member', VALUES), { title: 'Laptop', amount: 1200 });
    assert.equal(visibleFormValues(def, 'act_save', 'admin', VALUES), VALUES);
});

test('an empty visibleToRoles is open, as in the renderer', () => {
    const def = defOf([form([input('title', { visibleToRoles: [] })])]);
    assert.equal(visibleFormValues(def, 'act_save', 'member', VALUES), VALUES);
});

test('a gate AROUND the form is not a field gate (the action gate decides there)', () => {
    const def = defOf([{ id: 'box', type: 'container', props: {}, visibleToRoles: ['admin'], children: [form([input('title')], { visibleToRoles: ['admin'] })] }], {}, { visibleToRoles: ['admin'] });
    assert.equal(visibleFormValues(def, 'act_save', 'member', VALUES), VALUES);
});

test('one variant of a field per role: the name stays for both roles', () => {
    const def = defOf([form([
        input('amount', { visibleToRoles: ['admin'] }),
        input('amount', { visibleToRoles: ['member'], readOnly: true }),
        input('approvedBy', { visibleToRoles: ['admin'] }),
    ])]);
    assert.deepEqual(visibleFormValues(def, 'act_save', 'member', VALUES), { title: 'Laptop', amount: 1200 });
    assert.equal(visibleFormValues(def, 'act_save', 'admin', VALUES), VALUES);
});

test('only forms that run the action count; a second form that runs it can show the name', () => {
    const gated = form([input('approvedBy', { visibleToRoles: ['admin'] })]);
    const other = { ...form([input('approvedBy')]), id: 'frm_other', onSubmit: 'act_other' };
    assert.equal(visibleFormValues(defOf([gated, other]), 'act_other', 'member', VALUES), VALUES, 'the other action is not touched');
    assert.deepEqual(visibleFormValues(defOf([gated, other]), 'act_save', 'member', VALUES), { title: 'Laptop', amount: 1200 });
    const open = { ...other, onSubmit: 'act_save' };
    assert.equal(visibleFormValues(defOf([gated, open]), 'act_save', 'member', VALUES), VALUES, 'visible in a form that runs the same action');
});

test('an action wired on a component inside the form counts as run by the form', () => {
    const def = defOf([form([
        { id: 'sel', type: 'input_select', props: { name: 'status' }, onChange: 'act_status' },
        input('approvedBy', { visibleToRoles: ['admin'] }),
    ], { onSubmit: undefined })]);
    assert.deepEqual(visibleFormValues(def, 'act_status', 'member', { status: 'open', approvedBy: 'x' }), { status: 'open' });
});

test('an action the form reaches through call_action is covered too, at any depth', () => {
    const actions = {
        act_save: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_mid', params: {} }] },
        act_mid: { kind: 'call_action', actionId: 'act_leaf', params: {} },
        act_leaf: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 'tbl_x', values: {} }] },
        act_alone: { kind: 'sequence', steps: [] },
    };
    const def = defOf([form([input('title'), input('approvedBy', { visibleToRoles: ['admin'] })])], actions);
    assert.deepEqual([...gatedFormFieldNames(def, 'act_leaf', as('member'))], ['approvedBy']);
    assert.deepEqual([...gatedFormFieldNames(def, 'act_mid', as('member'))], ['approvedBy']);
    assert.equal(gatedFormFieldNames(def, 'act_alone', as('member')).size, 0);
});

test('an action a component outside the forms also starts keeps its bag (a row may share a field name)', () => {
    const gatedForm = form([input('title'), input('approvedBy', { visibleToRoles: ['admin'] })]);
    const row = { id: 'r1', title: 'Laptop', approvedBy: 'someone' };
    const grid = { id: 'grid', type: 'data_grid', props: { rowActions: [{ label: 'Save', actionId: 'act_save' }] } };
    assert.equal(visibleFormValues(defOf([gatedForm, grid]), 'act_save', 'member', row), row, 'rowActions');
    const list = { id: 'lst', type: 'list', props: {}, onRowClick: 'act_save' };
    assert.equal(visibleFormValues(defOf([gatedForm, list]), 'act_save', 'member', row), row, 'onRowClick');
    const loose = { id: 'sel', type: 'input_select', props: { name: 'approvedBy' }, onChange: 'act_save' };
    assert.equal(visibleFormValues(defOf([gatedForm, loose]), 'act_save', 'member', row), row, 'a field outside any form');
    const inner = form([input('approvedBy', { visibleToRoles: ['admin'] }), { ...grid, id: 'grid_in' }]);
    assert.equal(visibleFormValues(defOf([inner]), 'act_save', 'member', row), row, 'a row component inside the form');
    const actions = {
        act_row: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_save', params: {} }] },
        act_save: { kind: 'sequence', steps: [] },
    };
    const viaCall = { ...grid, props: { rowActions: [{ label: 'Save', actionId: 'act_row' }] } };
    assert.equal(visibleFormValues(defOf([gatedForm, viaCall], actions), 'act_save', 'member', row), row, 'through call_action');
});

test('a button (empty bag) does not lift the gate, inside or outside the form', () => {
    const def = defOf([
        form([input('title'), input('approvedBy', { visibleToRoles: ['admin'] }), { id: 'b_in', type: 'button', props: {}, onClick: 'act_save' }]),
        { id: 'b_out', type: 'button', props: {}, onClick: 'act_save' },
    ]);
    assert.deepEqual(visibleFormValues(def, 'act_save', 'member', VALUES), { title: 'Laptop', amount: 1200 });
});

test('a bag that is not a plain object, or that holds no gated name, comes back as it is', () => {
    const def = defOf([form([input('approvedBy', { visibleToRoles: ['admin'] })])]);
    const clean = { title: 'x' };
    assert.equal(visibleFormValues(def, 'act_save', 'member', clean), clean);
    for (const v of [null, undefined, 'text', 3, ['approvedBy']]) {
        assert.equal(withoutGatedFormFields(v, def, 'act_save', as('member')), v);
    }
});

test('other keys keep their order and stay own keys, also one named __proto__', () => {
    const def = defOf([form([input('approvedBy', { visibleToRoles: ['admin'] })])]);
    const sent = JSON.parse('{"b":1,"approvedBy":"x","__proto__":{"polluted":true},"a":2}');
    const out = visibleFormValues(def, 'act_save', 'member', sent);
    assert.deepEqual(Object.keys(out), ['b', '__proto__', 'a']);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(out.polluted, undefined);
});

test('visibleWhen and enabledWhen are not read: those values pass as they are', () => {
    const def = defOf([form([
        input('title', { visibleWhen: 'false' }),
        input('amount', { enabledWhen: { kind: 'formula', expr: 'false' } }),
        input('approvedBy', { visible: false, readOnly: true }),
    ])]);
    assert.equal(visibleFormValues(def, 'act_save', 'member', VALUES), VALUES);
});
