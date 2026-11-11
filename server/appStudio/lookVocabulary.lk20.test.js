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

