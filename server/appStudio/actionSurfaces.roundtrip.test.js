'use strict';

/**
 * The shapes the editor writes for the action surfaces of a data grid, and for a saved dataset's sort, limit
 * and either/or filter groups, are shapes the server already understands: canonicalize leaves them as they
 * are (a second pass changes nothing), and the aggregate compiler turns the dataset descriptor into SQL.
 * Run: cd server && node --test appStudio/actionSurfaces.roundtrip.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { SECTION_STYLE_DEFAULTS } = require('./componentSpecs');
const qc = require('../core/dataEngine/queryCompiler');

function wrap(children, actions) {
    return {
        schemaVersion: 1,
        meta: { name: 'T' },
        theme: {},
        homeScreenId: 'scr_main01',
        screens: [{ id: 'scr_main01', name: 'Home', sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children }] }],
        actions,
    };
}

// The defaults the editor gives a freshly made action of each kind (actionKindCatalog.ts, DEFAULTS_BY_KIND).
const NEW_ACTIONS = {
    act_new001: { kind: 'sequence', steps: [] },
    act_new002: { kind: 'toast', message: '', tone: 'info' },
    act_new003: { kind: 'open_url', url: '', newTab: true },
};

test('toolbarActions, bulkActions, addRowLabel and addRowActionId survive canonicalize unchanged', () => {
    const grid = {
        id: 'cmp_grid01', type: 'data_grid', visible: true,
        props: {
            source: { kind: 'static', value: [] },
            columns: [{ key: 'title', label: 'Title' }],
            selectable: 'multi',
            toolbarActions: [{ label: 'Export', actionId: 'act_new002', tone: 'primary' }, { label: 'Open', actionId: 'act_new003' }],
            bulkActions: [{ label: 'Flow', actionId: 'act_new001', tone: 'danger' }],
            addRowLabel: 'Add a row',
            addRowActionId: 'act_new002',
        },
        style: { span: 12 },
    };
    const first = canonicalizeAppDefinition(wrap([grid], NEW_ACTIONS));
    const props = first.def.screens[0].sections[0].children[0].props;
    assert.deepEqual(props.toolbarActions, grid.props.toolbarActions);
    assert.deepEqual(props.bulkActions, grid.props.bulkActions);
    assert.equal(props.addRowLabel, 'Add a row');
    assert.equal(props.addRowActionId, 'act_new002');
    assert.deepEqual(first.def.actions, NEW_ACTIONS);
    const second = canonicalizeAppDefinition(first.def);
    assert.deepEqual(second.repairs, []);
    assert.equal(JSON.stringify(second.def), JSON.stringify(first.def));
});

const TABLE = {
    id: 'tbl_aaaaaa',
    key: 'tickets',
    fields: [
        { id: 'f1', key: 'status', type: 'text' },
        { id: 'f2', key: 'region', type: 'text' },
        { id: 'f3', key: 'amount', type: 'number' },
    ],
};

test('a dataset descriptor with an either/or group, a sort by an output column and a limit compiles', () => {
    const descriptor = {
        groupBy: [{ field: 'region' }],
        aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }],
        filters: [
            { field: 'amount', op: 'gt', value: 10 },
            { any: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'status', op: 'eq', value: 'new' }] },
        ],
        sort: [{ field: 'total', dir: 'desc' }],
        limit: 5,
    };
    const { sql, params } = qc.compileAggregate(TABLE, { ...descriptor, dialect: 'sqlite' }, { where: '"created_by" = ?', params: ['u1'] });
    assert.match(sql, /\("status" = \? OR "status" = \?\)/);
    assert.match(sql, /ORDER BY "total" DESC LIMIT \?/);
    assert.deepEqual(params.at(-1), 5);
});

test('a sort by a column the answer does not have is refused (the editor never writes one)', () => {
    assert.throws(() => qc.compileAggregate(TABLE, {
        groupBy: [{ field: 'region' }], aggregates: [], sort: [{ field: 'amount', dir: 'asc' }], dialect: 'sqlite',
    }, { where: '1=1', params: [] }), /unknown output column/);
});
