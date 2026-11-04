/**
 * nodeActionRefs: the one reader of "which actions does this node run".
 *
 * Run: cd server && node --test appStudio/nodeActionRefs.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nodeActionRefs, ACTION_LIST_PROPS } = require('./nodeActionRefs.mts');
const { collectReferencedActions } = require('./validate/nodes');
const { collectAutomationRefs } = require('./automationRefs');

const FULL_NODE = {
    id: 'cmp_all00001',
    type: 'data_grid',
    onClick: 'act_click',
    onRowClick: 'act_rowclick',
    props: {
        itemActions: [{ label: 'Item', actionId: 'act_item' }],
        rowActions: [{ label: 'Row', actionId: 'act_row0' }, { label: 'Skip', actionId: '' }, { label: 'Row2', actionId: 'act_row2' }],
        bulkActions: [{ actionId: 'act_bulk' }],
        toolbarActions: [{ label: 'Tool', actionId: 'act_tool' }],
        addRowActionId: 'act_add',
        columns: [{ key: 'a' }, { key: 'b', label: 'Open', actionId: 'act_col' }],
    },
};

test('actions come in document order: events, the four lists, addRowActionId, columns', () => {
    assert.deepEqual(nodeActionRefs(FULL_NODE).map((r) => [r.actionId, r.via]), [
        ['act_click', 'onClick'],
        ['act_rowclick', 'onRowClick'],
        ['act_item', 'itemActions[0]'],
        ['act_row0', 'rowActions[0]'],
        ['act_row2', 'rowActions[2]'],
        ['act_bulk', 'bulkActions[0]'],
        ['act_tool', 'toolbarActions[0]'],
        ['act_add', 'addRowActionId'],
        ['act_col', 'columns[1]'],
    ]);
});

test('labels ride along when the entry has one; empty strings and non-strings are skipped', () => {
    const refs = nodeActionRefs(FULL_NODE);
    assert.equal(refs.find((r) => r.actionId === 'act_row0').label, 'Row');
    assert.equal(refs.find((r) => r.actionId === 'act_col').label, 'Open');
    assert.equal('label' in refs.find((r) => r.actionId === 'act_bulk'), false);
    assert.deepEqual(nodeActionRefs({ onClick: '', props: { rowActions: [{ actionId: 5 }, null, 'x'], addRowActionId: '', columns: 'no' } }), []);
});

test('a non-object is no refs, and children are not visited', () => {
    for (const v of [null, undefined, 'x', 5, [], [{ onClick: 'act_a' }]]) assert.deepEqual(nodeActionRefs(v), []);
    assert.deepEqual(nodeActionRefs({ type: 'card', children: [{ onClick: 'act_child' }] }), []);
});

test('the list props are the four the runtime renders', () => {
    assert.deepEqual([...ACTION_LIST_PROPS], ['itemActions', 'rowActions', 'bulkActions', 'toolbarActions']);
});

test('the unreachable rule and the automation index read the same ids as this walker', () => {
    const screens = [{ id: 'scr_main01', sections: [{ id: 'sec_main01', children: [FULL_NODE, { id: 'cmp_card0001', type: 'card', props: {}, children: [{ id: 'cmp_btn00001', type: 'button', onClick: 'act_nested' }] }] }] }];
    const expected = new Set([...nodeActionRefs(FULL_NODE).map((r) => r.actionId), 'act_nested']);
    assert.deepEqual(collectReferencedActions(screens), expected);
    const actions = Object.fromEntries([...expected].map((id) => [id, { kind: 'run_automation', automationId: `auto_${id}` }]));
    const refs = collectAutomationRefs({ screens, actions });
    assert.deepEqual(new Set(refs.entries.filter((e) => e.wired).map((e) => e.actionId)), expected);
});
