'use strict';

/**
 * The node walk's action wiring and on-screen advisories (nodeWiring.js),
 * against a minimal validation context.
 *
 * Run: cd server && node --test appStudio/validate/nodeWiring.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkActionWiring, checkNodeAdvisories, PANE_CLIP_CHILDREN } = require('./nodeWiring');

function ctxWith(actionIds = []) {
    const errors = [];
    const warnings = [];
    return {
        errors, warnings,
        ctx: { pushE: (r) => errors.push(r), pushW: (r) => warnings.push(r), actionIds: new Set(actionIds), target: { id: 'app_1', title: 'Desk' } },
    };
}

test('checkActionWiring: an event on a type without events, and an unknown action', () => {
    const { errors, ctx } = ctxWith(['save_record']);
    checkActionWiring({ type: 'heading', onClick: 'save_recrod' }, 's[0].children[0]', {}, { props: {}, events: [] }, ctx);
    assert.deepEqual(errors.map((e) => e.code), ['event.not_supported', 'event.action_unresolved']);
    assert.equal(errors[1].hint, 'Did you mean "save_record"?');
});

test('checkActionWiring: per-row action lists resolve, and an empty id is "not wired yet"', () => {
    const { errors, ctx } = ctxWith(['open_row']);
    checkActionWiring({ type: 'data_grid' }, 'p', { rowActions: [{ actionId: 'open_row' }, { actionId: '' }, { actionId: 7 }] }, { props: {}, events: [] }, ctx);
    assert.deepEqual(errors.map((e) => e.path), ['p.props.rowActions[2].actionId']);
});

test('checkNodeAdvisories: an inert button carries the Finding target', () => {
    const { warnings, ctx } = ctxWith();
    checkNodeAdvisories({ type: 'button', id: 'btn_1' }, 'p', {}, null, ctx);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'component.control_inert');
    assert.deepEqual(warnings[0].targetRef, { kind: 'app', id: 'app_1', title: 'Desk', path: 'p', nodeId: 'btn_1' });
});

test('checkNodeAdvisories: a submit button inside a form is fine, outside it is inert', () => {
    const inside = ctxWith();
    checkNodeAdvisories({ type: 'button' }, 'p', { role: 'submit' }, 'form_1', inside.ctx);
    assert.equal(inside.warnings.length, 0);
    const outside = ctxWith();
    checkNodeAdvisories({ type: 'button' }, 'p', { role: 'submit' }, null, outside.ctx);
    assert.match(outside.warnings[0].message, /outside a form/);
});

test('checkNodeAdvisories: a pane that clips, and a form whose Submit does nothing', () => {
    const { warnings, ctx } = ctxWith();
    const children = Array.from({ length: PANE_CLIP_CHILDREN + 1 }, () => ({ type: 'text' }));
    checkNodeAdvisories({ type: 'pane', children }, 'p', {}, null, ctx);
    checkNodeAdvisories({ type: 'pane', children: [...children, { type: 'text', style: { height: 'fill' } }] }, 'q', {}, null, ctx);
    checkNodeAdvisories({ type: 'form' }, 'r', {}, null, ctx);
    checkNodeAdvisories({ type: 'form' }, 's', { showSubmit: false }, null, ctx);
    assert.deepEqual(warnings.map((w) => `${w.path}:${w.code}`), ['p:component.pane_clips', 'r:form.no_submit_action']);
});
