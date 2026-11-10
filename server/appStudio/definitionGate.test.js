/**
 * The definition gate (definitionGate.mts): two refusals, a report for the
 * rest, and never a rewritten definition.
 *
 * Run: cd server && node --test appStudio/definitionGate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { gateDefinition, gateFindings } = require('./definitionGate.mts');
const { emptyDefinition, SCHEMA_VERSION_CURRENT } = require('./componentSpecs');

test('refuses what is not an object', () => {
    for (const input of [undefined, null, 'x', 7, [], [{}]]) {
        const gate = gateDefinition(input);
        assert.equal(gate.verdict, 'refuse');
        assert.equal(gate.refused, 'not_object');
        assert.deepEqual(gate.errors.map((e) => e.code), ['shape.not_object']);
        assert.deepEqual(gate.repairs, []);
    }
});

test('refuses a schema version newer than this installation reads', () => {
    const gate = gateDefinition({ ...emptyDefinition('Later'), schemaVersion: SCHEMA_VERSION_CURRENT + 1 });
    assert.equal(gate.verdict, 'refuse');
    assert.equal(gate.refused, 'schema_newer');
    assert.deepEqual(gate.errors.map((e) => e.code), ['shape.schema_newer']);
    assert.match(gate.errors[0].message, /newer version/);
});

test('every version this installation reads passes the refusal, the newest one included', () => {
    for (const schemaVersion of [1, 2, SCHEMA_VERSION_CURRENT]) {
        assert.notEqual(gateDefinition({ ...emptyDefinition('Known'), schemaVersion }).verdict, 'refuse');
    }
});

test('ok: a definition the validator has no error for', () => {
    const gate = gateDefinition(emptyDefinition('Fine'));
    assert.equal(gate.verdict, 'ok');
    assert.equal(gate.refused, null);
    assert.deepEqual(gate.errors, []);
    assert.equal(gateFindings(gate), null);
});

test('warn: validator errors are reported, with what canonicalize would repair', () => {
    const gate = gateDefinition({ actions: {} });
    assert.equal(gate.verdict, 'warn');
    assert.equal(gate.refused, null);
    assert.ok(gate.errors.some((e) => e.code === 'screens.missing'), JSON.stringify(gate.errors));
    assert.ok(gate.repairs.length > 0);
    assert.deepEqual(Object.keys(gateFindings(gate)), ['errors', 'warnings']);
});

test('the definition handed in is never changed, whatever the verdict', () => {
    const inputs = [
        { actions: {} },
        { schemaVersion: 1, screens: [{ title: 'One', sections: [{ components: [{ type: 'text' }] }] }] },
        { ...emptyDefinition('Later'), schemaVersion: SCHEMA_VERSION_CURRENT + 1 },
    ];
    for (const input of inputs) {
        const before = JSON.stringify(input);
        const gate = gateDefinition(input);
        assert.equal(JSON.stringify(input), before);
        assert.equal('def' in gate, false);
        assert.equal('definition' in gate, false);
    }
});

test('it does not throw: a check that cannot run is a warn', () => {
    const hostile = { get screens() { throw new Error('boom'); } };
    const gate = gateDefinition(hostile);
    assert.equal(gate.verdict, 'warn');
    assert.deepEqual(gate.errors.map((e) => e.code), ['gate.check_failed']);
});
