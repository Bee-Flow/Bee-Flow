/**
 * app_find_nodes {actionId}: every way a component can run, or read the result of, an action.
 *
 * Run: cd server && node --test appStudio/builderTools/findNodesTool.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyFindNodes } = require('./findNodesTool');
const { collectReferencedActions } = require('../validate/nodes');

const defWith = (children, actions = {}) => ({
    screens: [{ id: 'scr_main01', name: 'Main', sections: [{ id: 'sec_main01', children }] }],
    actions,
});
const find = (def, args) => applyFindNodes({ def, dataModel: { tables: [] } }, args);
const toast = { kind: 'toast', message: 'x' };

const GRID_FORMS = [
    ['rowActions', { rowActions: [{ label: 'Do', actionId: 'act_x' }] }, /runs action \(rowActions\[0\]\)/],
    ['toolbarActions', { toolbarActions: [{ label: 'A', actionId: 'act_other' }, { label: 'Do', actionId: 'act_x' }] }, /runs action \(toolbarActions\[1\]\)/],
    ['bulkActions', { bulkActions: [{ label: 'Do', actionId: 'act_x' }] }, /runs action \(bulkActions\[0\]\)/],
    ['columns[].actionId', { columns: [{ key: 'a' }, { key: 'b', actionId: 'act_x' }] }, /runs action \(columns\[1\]\)/],
    ['addRowActionId', { addRowActionId: 'act_x' }, /runs action \(addRowActionId\)/],
];

for (const [name, props, why] of GRID_FORMS) {
    test(`a data_grid with ${name} gives a hit for { actionId: "act_x" }`, () => {
        const def = defWith([{ id: 'cmp_grid001', type: 'data_grid', props }], { act_x: toast });
        const r = find(def, { actionId: 'act_x' });
        const hit = r.hits.find((h) => h.id === 'cmp_grid001');
        assert.ok(hit, JSON.stringify(r));
        assert.match(hit.why, why);
        assert.match(hit.why, /^runs action/, 'the "runs action" prefix is kept');
        assert.ok(!/unreachable/.test(r.note || ''), 'a wired action is not called unreachable');
    });
}

test('a spec case: a grid with rowActions [act_x] gives a hit for app_find_nodes {actionId:"act_x"}', () => {
    const def = defWith([{ id: 'cmp_grid001', type: 'data_grid', props: { rowActions: [{ label: 'Do', actionId: 'act_x' }] } }], { act_x: toast });
    const r = find(def, { actionId: 'act_x' });
    assert.equal(r.hits.filter((h) => h.kind === 'component').length, 1);
    assert.match(r.hits[0].why, /runs action \(rowActions\[0\]\)/);
});

test('repeater itemActions and a plain event are found and say where', () => {
    const def = defWith([
        { id: 'cmp_rep0001', type: 'repeater', props: { itemActions: [{ label: 'Go', actionId: 'act_x' }] } },
        { id: 'cmp_btn0001', type: 'button', props: { label: 'Go' }, onClick: 'act_x' },
    ], { act_x: toast });
    const r = find(def, { actionId: 'act_x' });
    assert.match(r.hits.find((h) => h.id === 'cmp_rep0001').why, /runs action \(itemActions\[0\]\)/);
    assert.match(r.hits.find((h) => h.id === 'cmp_btn0001').why, /runs action \(onClick\)/);
});

test('an actionResult binding reads the result; it does not run the action', () => {
    const def = defWith([{ id: 'cmp_txt0001', type: 'text', props: { text: { kind: 'actionResult', actionId: 'act_x', path: 'summary' } } }], { act_x: toast });
    const r = find(def, { actionId: 'act_x' });
    const hit = r.hits.find((h) => h.id === 'cmp_txt0001');
    assert.equal(hit.why, 'reads its result');
});

test('another action that references this one is reported as such', () => {
    const def = defWith([], {
        act_x: toast,
        act_y: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'v', value: { kind: 'actionResult', actionId: 'act_x' } }] },
    });
    const r = find(def, { actionId: 'act_x' });
    assert.equal(r.hits.find((h) => h.id === 'act_y').why, 'references this action');
    assert.equal(r.hits.find((h) => h.id === 'act_x').why, 'is this action');
});

test('an action that call_actions this one says where it calls it', () => {
    const def = defWith([], {
        act_x: toast,
        act_y: { kind: 'sequence', steps: [toast, { kind: 'call_action', actionId: 'act_x', params: {} }] },
    });
    const r = find(def, { actionId: 'act_x' });
    assert.equal(r.hits.find((h) => h.id === 'act_y').why, 'calls this action (steps[1])');
});

test('an action nothing runs, calls or reads: the note says it is unreachable and safe to remove', () => {
    const r = find(defWith([], { act_x: toast }), { actionId: 'act_x' });
    assert.match(r.note, /Nothing runs, calls or reads action "act_x" — it is unreachable \(validator warning action\.unreachable\), so it is safe to remove\./);
});

test('an unknown id keeps its "NOT a confirmation" note', () => {
    const r = find(defWith([], { act_x: toast }), { actionId: 'act_nope' });
    assert.equal(r.hits.length, 0);
    assert.match(r.note, /is not an action of this app.*NOT a confirmation/);
});

test('find and the validator agree on which actions a grid wires', () => {
    const children = [{ id: 'cmp_grid001', type: 'data_grid', props: { rowActions: [{ actionId: 'act_r' }], bulkActions: [{ actionId: 'act_b' }], addRowActionId: 'act_a', columns: [{ actionId: 'act_c' }] } }];
    const def = defWith(children, { act_r: toast, act_b: toast, act_a: toast, act_c: toast });
    for (const id of collectReferencedActions(def.screens)) {
        assert.ok(find(def, { actionId: id }).hits.some((h) => h.kind === 'component'), `${id} is found`);
    }
});

test('with a screenId an action wired on another screen is not called unreachable', () => {
    const def = {
        screens: [
            { id: 'scr_a', name: 'A', sections: [{ id: 'sec_a', children: [] }] },
            { id: 'scr_b', name: 'B', sections: [{ id: 'sec_b', children: [{ id: 'cmp_grid001', type: 'data_grid', props: { rowActions: [{ label: 'Do', actionId: 'act_x' }] } }] }] },
        ],
        actions: { act_x: toast },
    };
    const r = find(def, { actionId: 'act_x', screenId: 'scr_a' });
    assert.ok(!/unreachable/.test(r.note || ''), JSON.stringify(r));
});
