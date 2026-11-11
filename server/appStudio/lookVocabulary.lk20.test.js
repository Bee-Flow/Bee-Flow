'use strict';

/**
 * Package LK20 and LK21b (schema 3): the repeater item layout, the item templates of list and
 * kanban, column templates, and the types and keys added after them. What these tests hold: a
 * definition without the new vocabulary keeps its bytes and schema version 2, one with it is
 * kept as written and stored as version 3, and the validator says what is wrong with a bad value.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('./componentSpecs');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { requiredSchemaVersion } = require('./schemaSince.mts');

/** A definition whose first section holds `nodes`, canonicalized; `actions` beside them. */
function canon(nodes, actions = {}) {
    const def = specs.emptyDefinition('Look vocabulary');
    def.screens[0].sections[0].children = nodes;
    def.actions = actions;
    return canonicalizeAppDefinition(def).def;
}

const firstNode = (def) => def.screens[0].sections[0].children[0];
const codes = (findings) => findings.map((f) => `${f.code} @ ${f.path}`);

const repeater = (props = {}) => ({ id: 'cmp_rep00001', type: 'repeater', props: { source: { kind: 'static', value: [] }, ...props }, children: [] });

test('a repeater without a layout keeps its bytes and version 2', () => {
    const def = canon([repeater()]);
    assert.deepEqual(Object.keys(firstNode(def).props), ['source', 'itemActions', 'emptyText']);
    assert.equal(requiredSchemaVersion(def), 2);
    assert.equal(def.schemaVersion, 2);
});

test('the repeater item layout is kept when set and stamps version 3', () => {
    const def = canon([repeater({ layout: 'grid', itemColumns: 4, itemColumnsMd: 2, itemColumnsSm: 1 })]);
    const props = firstNode(def).props;
    assert.deepEqual([props.layout, props.itemColumns, props.itemColumnsMd, props.itemColumnsSm], ['grid', 4, 2, 1]);
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(validateAppDefinition(def).errors, []);
    // null means not set: the key is left out.
    assert.equal('layout' in firstNode(canon([repeater({ layout: null })])).props, false);
});

test('a bad repeater layout is an error with the legal values', () => {
    const def = canon([repeater({ layout: 'masonry', itemColumns: 9 })]);
    assert.deepEqual(codes(validateAppDefinition(def).errors).sort(), [
        'prop.enum @ screens[0].sections[0].children[0].props.layout',
        'prop.range @ screens[0].sections[0].children[0].props.itemColumns',
    ]);
});


const { baseCatalogue, extensionItems } = require('./catalogTiers.mts');
const { renderExtensionEntry } = require('./builderPrompt/extensionIndex.mts');

const title = (id) => ({ id, type: 'text', props: { text: 'x' }, computed: { text: 'item.title' } });
const list = (extra = {}) => ({ id: 'cmp_list0001', type: 'list', props: { source: { kind: 'static', value: [] } }, ...extra });

test('a list or kanban without a template keeps its bytes and version 2', () => {
    for (const node of [list(), list({ children: [] }), { id: 'cmp_kan00001', type: 'kanban', props: {}, children: [] }]) {
        const def = canon([node]);
        assert.equal('children' in firstNode(def), false, node.type);
        assert.equal(def.schemaVersion, 2, node.type);
    }
});

test('a list row template and a kanban card template are kept, validated and stamp version 3', () => {
    for (const type of ['list', 'kanban']) {
        const def = canon([{ id: 'cmp_host0001', type, props: {}, children: [title('cmp_tpl00001')] }]);
        assert.deepEqual(firstNode(def).children.map((c) => c.id), ['cmp_tpl00001'], type);
        assert.equal(def.schemaVersion, 3, type);
        assert.deepEqual(validateAppDefinition(def).errors, [], type);
    }
});

test('the AI builder sees list and kanban as they were, and the template in the extension index', () => {
    for (const type of ['list', 'kanban']) {
        const base = baseCatalogue().COMPONENT_SPECS[type];
        assert.equal(base.container, undefined, type);
        assert.equal(base.childrenSince, undefined, type);
        const item = extensionItems().find((i) => i.name === `${type}.children`);
        assert.equal(item.family, 'nodeKeys');
        assert.match(renderExtensionEntry(item), new RegExp(`^${type}\\.children: component nodes drawn per`));
    }
});

const tableWith = (column) => ({ id: 'cmp_tbl00001', type: 'table', props: { source: { kind: 'static', value: [] }, columns: [{ key: 'name', ...column }] } });

test('a template column is kept, stamps version 3 and must compile', () => {
    const good = canon([tableWith({ format: 'template', template: 'item.first + " " + item.last' })]);
    assert.equal(firstNode(good).props.columns[0].template, 'item.first + " " + item.last');
    assert.equal(good.schemaVersion, 3);
    assert.deepEqual(validateAppDefinition(good).errors, []);
    assert.equal(canon([tableWith({ format: 'text' })]).schemaVersion, 2);

    const bad = validateAppDefinition(canon([tableWith({ format: 'template', template: 'item.first +' })]));
    assert.deepEqual(codes(bad.errors), ['column.template_invalid @ screens[0].sections[0].children[0].props.columns[0].template']);
    const missing = validateAppDefinition(canon([{ ...tableWith({ format: 'template' }), type: 'data_grid' }]));
    assert.ok(codes(missing.warnings).includes('column.template_missing @ screens[0].sections[0].children[0].props.columns[0].template'));
});

test('a gauge is a schema 3 type with a range to draw in', () => {
    const def = canon([{ id: 'cmp_gauge001', type: 'gauge', props: { value: { kind: 'static', value: 3 }, thresholds: [{ from: 50, tone: 'warning' }] } }]);
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(firstNode(def).props.thresholds, [{ from: 50, tone: 'warning' }]);
    assert.deepEqual(validateAppDefinition(def).errors, []);
    const flat = validateAppDefinition(canon([{ id: 'cmp_gauge001', type: 'gauge', props: { min: 10, max: 10 } }]));
    assert.ok(codes(flat.warnings).includes('gauge.range_invalid @ screens[0].sections[0].children[0].props.max'));
});

test('the chart kinds of schema 3 and the combo series keys stamp version 3, the base kinds stay 2', () => {
    const chart = (props) => canon([{ id: 'cmp_chart001', type: 'chart', props: { source: { kind: 'static', value: [] }, ...props } }]);
    assert.equal(chart({ chartType: 'line', series: [{ key: 'a' }] }).schemaVersion, 2);
    for (const kind of ['combo', 'scatter', 'funnel', 'radar']) assert.equal(chart({ chartType: kind }).schemaVersion, 3, kind);
    const combo = chart({ chartType: 'combo', series: [{ key: 'a', type: 'line', yAxis: 'right' }] });
    assert.deepEqual(firstNode(combo).props.series, [{ key: 'a', type: 'line', yAxis: 'right' }]);
    assert.deepEqual(validateAppDefinition(combo).errors, []);
    assert.ok(codes(validateAppDefinition(chart({ chartType: 'combo', series: [{ key: 'a', type: 'pie' }] })).errors)[0].startsWith('prop.item_invalid'));
});

test('a wizard keeps its step bodies, needs version 3 and says when steps and bodies differ', () => {
    const box = (id) => ({ id, type: 'container', props: {}, children: [] });
    const input = { id: 'cmp_in000001', type: 'input_text', props: { name: 'who', label: 'Who' } };
    const wizard = (children) => ({ id: 'cmp_wiz00001', type: 'wizard', props: { steps: [{ title: 'One' }, { title: 'Two' }] }, children });
    const form = (inner) => ({ id: 'cmp_form0001', type: 'form', props: { name: 'f' }, onSubmit: 'act_send0001', children: [inner] });
    const def = canon([form(wizard([{ ...box('cmp_box00001'), children: [input] }, box('cmp_box00002')]))], { act_send0001: { kind: 'toast', message: 'x' } });
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(firstNode(def).children[0].children.map((c) => c.id), ['cmp_box00001', 'cmp_box00002']);
    const result = validateAppDefinition(def);
    assert.deepEqual(result.errors, []);
    assert.equal(codes(result.warnings).some((c) => c.startsWith('wizard.')), false);
    const short = validateAppDefinition(canon([wizard([box('cmp_box00001')])]));
    assert.ok(codes(short.warnings).includes('wizard.steps_mismatch @ screens[0].sections[0].children[0].props.steps'));
});

test('a tree reads through an ordinary data binding and is bounded by its limits', () => {
    const { collectDataBindings } = require('./collectDataBindings');
    const source = { kind: 'records', tableId: 'tbl_places', limit: 200 };
    const def = canon([{ id: 'cmp_tree0001', type: 'tree', props: { source, parentKey: 'parent', maxDepth: 4 }, onRowClick: 'act_open0001' }], { act_open0001: { kind: 'toast', message: 'x' } });
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(collectDataBindings(def).map((b) => [b.nodeId, b.prop]), [['cmp_tree0001', 'source']]);
    assert.deepEqual(validateAppDefinition(def, { strict: false }).errors.filter((f) => !f.code.startsWith('binding.')), []);
    const tooDeep = validateAppDefinition(canon([{ id: 'cmp_tree0001', type: 'tree', props: { maxDepth: 40, maxNodes: 5000 } }]));
    assert.deepEqual(codes(tooDeep.errors).sort(), [
        'prop.range @ screens[0].sections[0].children[0].props.maxDepth',
        'prop.range @ screens[0].sections[0].children[0].props.maxNodes',
    ]);
});

test('a tooltip on any node is kept as trimmed text, stamps version 3 and is checked', () => {
    const text = (extra) => ({ id: 'cmp_text0001', type: 'text', props: { text: 'VAT' }, ...extra });
    const def = canon([text({ tooltip: '  Value added tax, 21%  ' })]);
    assert.equal(firstNode(def).tooltip, 'Value added tax, 21%');
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(validateAppDefinition(def).errors, []);
    for (const gone of [null, '', '   ', 42]) assert.equal('tooltip' in firstNode(canon([text({ tooltip: gone })])), false, String(gone));
    assert.equal(canon([text({ tooltip: 'x'.repeat(300) })]).screens[0].sections[0].children[0].tooltip.length, 200);
    const raw = specs.emptyDefinition('raw');
    raw.screens[0].sections[0].children = [text({ tooltip: 7 })];
    assert.ok(codes(validateAppDefinition(raw).errors).includes('node.tooltip_invalid @ screens[0].sections[0].children[0].tooltip'));
});
