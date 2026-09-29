const test = require('node:test');
const assert = require('node:assert/strict');
const { COMPONENT_TYPE_ALIASES, canonicalComponentType } = require('./componentAliases');
const { getSpec } = require('../componentSpecs');

test('every alias names a REAL type, and no alias shadows a real type', () => {
    for (const [alias, target] of Object.entries(COMPONENT_TYPE_ALIASES)) {
        assert.ok(getSpec(target), `${alias} → ${target}: target must be a component type`);
        assert.ok(!getSpec(alias), `${alias} is itself a component type — aliasing it would hide the real one`);
    }
    assert.equal('table' in COMPONENT_TYPE_ALIASES, false, 'table is a real type');
});

test('canonicalComponentType folds case and whitespace, passes real types through', () => {
    assert.equal(canonicalComponentType(' KPI '), 'stat');
    assert.equal(canonicalComponentType('data_grid'), 'data_grid');
    assert.equal(canonicalComponentType('Table'), 'table');
    assert.equal(canonicalComponentType(''), null);
    assert.equal(canonicalComponentType(null), null);
    // A type spelt as prose is the underscore type it names (measured on
    // Gemma: "data grid" for data_grid) — and an alias spelt that way too.
    assert.equal(canonicalComponentType('data grid'), 'data_grid');
    assert.equal(canonicalComponentType('Page-Header'), 'page_header');
    assert.equal(canonicalComponentType('text input'), 'input_text');
});
