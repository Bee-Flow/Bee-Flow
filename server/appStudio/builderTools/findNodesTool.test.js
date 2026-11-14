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

// The rest of the search: arguments, tables, variables, screens and the notes.
const tbl = { id: 'tbl_orders', key: 'orders' };
const gridOn = (id, tableId) => ({ id, type: 'data_grid', props: { source: { kind: 'records', tableId } } });

test('no target is refused; an unknown component type names the valid ones', () => {
    assert.deepEqual(find(defWith([]), { screenId: 'scr_main01' }), {
        error: 'app_find_nodes needs at least one of componentType, tableId, actionId or variable.',
        _fixHint: 'Pass what you are looking for, e.g. { tableId: "tbl_x" } to find everything bound to that table.',
    });
    const r = find(defWith([]), { componentType: 'no such thing' });
    assert.equal(r.error, 'Unknown component type "no_such_thing".');
    assert.match(r._fixHint, /^Valid types: heading, text, /);
});

test('a component type is read the catalog way, and a node without a type or a screen without a name still reads', () => {
    const def = { screens: [{ id: 'scr_x', sections: [{ id: 'sec_x', children: [{ id: 'cmp_t', type: 'text', children: [{ id: 'cmp_in', type: 'text' }, null] }, { id: 'cmp_q' }] }] }] };
    const r = applyFindNodes({ def }, { componentType: ' Text ' });
    assert.deepEqual(r.hits, [
        { kind: 'component', id: 'cmp_t', type: 'text', screenId: 'scr_x', screenName: 'scr_x', path: 'sec_x > text', why: 'type' },
        { kind: 'component', id: 'cmp_in', type: 'text', screenId: 'scr_x', screenName: 'scr_x', path: 'sec_x > text > text', why: 'type' },
    ]);
    assert.equal(r.hitCount, 2);
    assert.equal(r.note, undefined);
    assert.deepEqual(applyFindNodes({}, { componentType: 'text' }), { hits: [], hitCount: 0, note: 'Nothing in the draft references it: unused, so it is safe to remove.' });
});

test('a table is found by id or key, in bindings and in actions; a missing data model is never a go-ahead', () => {
    const def = defWith([gridOn('cmp_g1', 'tbl_orders'), gridOn('cmp_g2', 'tbl_other')], {
        act_save: { kind: 'sequence', steps: [{ kind: 'insert_record', tableId: 'orders' }] },
        act_none: { steps: [] },
    });
    const byKey = applyFindNodes({ def, dataModel: { tables: [tbl] } }, { tableId: 'orders' });
    assert.deepEqual(byKey.hits.map((h) => [h.kind, h.id, h.why]), [['component', 'cmp_g1', 'bound via source'], ['action', 'act_save', 'touches table']]);
    const unloaded = applyFindNodes({ def }, { tableId: 'tbl_orders' });
    assert.deepEqual(unloaded.hits.map((h) => h.id), ['cmp_g1']);
    assert.equal(unloaded.note, undefined);
    const nothing = applyFindNodes({ def }, { tableId: 'tbl_gone' });
    assert.equal(nothing.note, 'Nothing matches, and tableId "tbl_gone" could not be checked (the data model is not loaded). Check the id; this is NOT a confirmation that anything is unused.');
    const notOurs = applyFindNodes({ def, dataModel: { tables: [tbl] } }, { tableId: 'tbl_gone' });
    assert.match(notOurs.note, /tableId "tbl_gone" is not a table of this app/);
});

test('a variable is read from props and from actions; an undeclared one says so', () => {
    const def = {
        ...defWith([{ id: 'cmp_t', type: 'text', props: { text: '{{vars.count}}' } }, { id: 'cmp_u', type: 'text', props: { text: 'x' } }],
            { act_set: { kind: 'set_variable', name: 'count' }, act_read: { kind: 'toast', message: '{{vars.count}}' }, act_no: { kind: 'toast' } }),
        variables: [{ name: 'count' }],
    };
    const r = find(def, { variable: 'count' });
    assert.deepEqual(r.hits.map((h) => [h.id, h.why, h.type]), [['cmp_t', 'reads variable', 'text'], ['act_set', 'reads/writes variable', 'set_variable'], ['act_read', 'reads/writes variable', 'toast']]);
    assert.equal(r.note, undefined);
    const undeclared = find({ ...def, variables: undefined }, { variable: 'nope' });
    assert.equal(undeclared.note, 'Nothing matches, and variable "nope" is not declared in this app. Check the id; this is NOT a confirmation that anything is unused.');
});

test('an action without a kind is a sequence; several reasons join in order', () => {
    const def = { ...defWith([], { act_x: { steps: [{ kind: 'insert_record', tableId: 'tbl_orders' }, { kind: 'set_variable', name: 'count' }] } }), variables: [{ name: 'count' }] };
    const r = applyFindNodes({ def, dataModel: { tables: [tbl] } }, { tableId: 'tbl_orders', variable: 'count', actionId: 'act_x' });
    assert.deepEqual(r.hits, [{ kind: 'action', id: 'act_x', type: 'sequence', why: 'touches table; reads/writes variable; is this action' }]);
    assert.equal(r.note, undefined, 'only an actionId alone can be called unreachable');
});

test('a screenId limits the walk; screens and sections that are not objects are skipped', () => {
    const def = {
        screens: [null, 'x', { id: 'scr_a', sections: [null, { id: 'sec_a', children: [{ id: 'cmp_a', type: 'text' }] }] }, { id: 'scr_b', name: 'B', sections: [{ id: 'sec_b', children: [{ id: 'cmp_b', type: 'text' }] }] }],
    };
    assert.deepEqual(applyFindNodes({ def }, { componentType: 'text', screenId: 'scr_b' }).hits.map((h) => [h.id, h.screenName, h.path]), [['cmp_b', 'B', 'sec_b > text']]);
    assert.deepEqual(applyFindNodes({ def }, { componentType: 'text' }).hits.map((h) => h.id), ['cmp_a', 'cmp_b']);
});

test('more than 60 hits: the first 60, flagged as truncated, with the narrowing note', () => {
    const children = Array.from({ length: 61 }, (_, i) => ({ id: `cmp_${i}`, type: 'text' }));
    const r = find(defWith(children, { act_x: toast }), { componentType: 'text' });
    assert.equal(r.hits.length, 60);
    assert.equal(r.hitCount, 60);
    assert.equal(r.truncated, true);
    assert.equal(r.note, 'Showing the first 60 matches — narrow the query with screenId.');
    const actionOnly = find(defWith(children.map((c) => ({ ...c, onClick: 'act_x' })), { act_x: toast }), { actionId: 'act_x' });
    assert.ok(!/unreachable/.test(actionOnly.note || ''));
});
