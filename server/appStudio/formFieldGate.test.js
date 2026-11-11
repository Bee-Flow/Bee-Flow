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

// ── The other forms of a wide server scope (forms.<form name>.<field>) ──────────

const { withoutGatedFormsFields } = require('./formFieldGate.mts');
const { wideScopeFor } = require('../routes/studioAppRunGate');
const { buildServerScope } = require('./actionExecutor/shared');

const WIDE_FORM = () => form([input('title'), input('amount'), input('approvedBy', { visibleToRoles: ['admin'] })]);

test('forms of the wide scope follow the fields the role sees in the form of that name', () => {
    const def = { ...defOf([WIDE_FORM()]), serverScope: 'wide' };
    const body = { forms: { request: { ...VALUES } }, screenParams: { id: 'r1' } };
    const member = wideScopeFor(def, 'member', body).wideScope;
    assert.deepEqual({ ...member.forms.request }, { title: 'Laptop', amount: 1200 });
    assert.deepEqual({ ...member.screen.params }, { id: 'r1' }, 'the rest of the scope is untouched');
    assert.equal(buildServerScope({ wideScope: member }).forms.request.approvedBy, undefined, 'a formula reads nothing there');
    assert.deepEqual({ ...wideScopeFor(def, null, body).wideScope.forms.request }, { title: 'Laptop', amount: 1200 }, 'a viewer without a role clears open gates only');
    assert.equal(wideScopeFor(def, 'admin', body).wideScope.forms.request.approvedBy, 'someone', 'the named role sends it');
    assert.equal(wideScopeFor(def, 'owner', body).wideScope.forms.request.approvedBy, 'someone', 'the owner sends everything');
});

test('a form without a name is read under its node id, as the page publishes it', () => {
    const def = { ...defOf([form([input('approvedBy', { visibleToRoles: ['admin'] })], { props: {} })]), serverScope: 'wide' };
    const out = wideScopeFor(def, 'member', { forms: { frm: { approvedBy: 'x', note: 'y' } } }).wideScope;
    assert.deepEqual({ ...out.forms.frm }, { note: 'y' });
});

test('each form is read on its own: the same field name in another form keeps its value', () => {
    const other = { id: 'frm_2', type: 'form', props: { name: 'review' }, children: [input('approvedBy')] };
    const def = defOf([WIDE_FORM(), other]);
    const sent = { request: { approvedBy: 'a' }, review: { approvedBy: 'b' }, unknown: { approvedBy: 'c' } };
    const out = withoutGatedFormsFields(sent, def, as('member'));
    assert.deepEqual(JSON.parse(JSON.stringify(out)), { request: {}, review: { approvedBy: 'b' }, unknown: { approvedBy: 'c' } });
});

test('two variants of one field in the same form, one per role, keep the value for both roles', () => {
    const def = defOf([form([input('approvedBy', { visibleToRoles: ['admin'] }), input('approvedBy', { visibleToRoles: ['member'] })])]);
    const sent = { request: { approvedBy: 'a' } };
    assert.equal(withoutGatedFormsFields(sent, def, as('member')), sent);
    assert.equal(withoutGatedFormsFields(sent, def, as('admin')), sent);
    assert.deepEqual({ ...withoutGatedFormsFields(sent, def, as('guest')).request }, {});
});

test('nothing gated, or nothing to leave out: the same object; an app without the wide scope gets no key', () => {
    const open = defOf([form([input('title')])]);
    const sent = { request: { title: 'x' } };
    assert.equal(withoutGatedFormsFields(sent, open, as('member')), sent);
    const gated = defOf([WIDE_FORM()]);
    assert.equal(withoutGatedFormsFields(sent, gated, as('member')), sent);
    for (const v of [null, undefined, 'text', 3, ['request']]) assert.equal(withoutGatedFormsFields(v, gated, as('member')), v);
    assert.deepEqual(wideScopeFor(gated, 'member', { forms: { request: { ...VALUES } } }), {}, 'no serverScope: wide');
});

test('the kept forms stay own keys without a prototype, also one named __proto__', () => {
    const def = defOf([WIDE_FORM()]);
    const sent = JSON.parse('{"request":{"approvedBy":"x","__proto__":{"polluted":true},"title":"t"}}');
    const out = withoutGatedFormsFields(sent, def, as('member'));
    assert.equal(Object.getPrototypeOf(out), null);
    assert.equal(Object.getPrototypeOf(out.request), null);
    assert.deepEqual(Object.keys(out.request), ['__proto__', 'title']);
    assert.equal(out.request.polluted, undefined);
});
