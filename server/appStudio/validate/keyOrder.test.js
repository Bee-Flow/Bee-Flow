'use strict';

/**
 * The validator and the dry run say the same about a stored definition whatever the order of its
 * object keys. Postgres JSONB hands a definition back with its keys in another order (shorter
 * keys first), and the checks that ask "is this value already what canonicalize would keep"
 * (styleWhen, object props, value formats, theme overrides, design values, nav.brand) once
 * compared JSON texts, so a clean v3 app read from the database got errors it did not have.
 *
 * Every corpus app that uses those parts is checked in its canonical form, with every object's
 * keys reversed, and in JSONB's order: the findings must be exactly the same.
 *
 * Run: cd server && node --test appStudio/validate/keyOrder.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { readCorpus } = require('../compat/corpus.mts');
const { canonicalOf } = require('../compat/expectations.mts');
const { validateAppDefinition } = require('../validate');
const { appDryRun } = require('../appDryRun');
const { sameJsonValue } = require('../../shared/format/sameJsonValue.mjs');

const APPS = [
    'vocab-style-when', 'vocab-theme-scope', 'value-format', 'nav-shell-options',
    'template-field-service', 'template-request-approval', 'template-sales-dashboard', 'template-inbound-orders',
];

/** Rebuild every object with its keys in `order`; arrays keep their order. */
function rekey(value, order) {
    if (Array.isArray(value)) return value.map((v) => rekey(v, order));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(order(Object.keys(value)).map((k) => [k, rekey(value[k], order)]));
}

const reversed = (keys) => [...keys].sort().reverse();
// JSONB: shorter keys first, then bytewise.
const jsonb = (keys) => [...keys].sort((a, b) => (Buffer.byteLength(a) - Buffer.byteLength(b)) || Buffer.compare(Buffer.from(a), Buffer.from(b)));

/**
 * A dry run's lists in a fixed order: the action pass walks `def.actions`, a map, so the order of
 * its entries follows the map's keys. What it finds must not change; the order it lists them in may.
 */
function settled(result) {
    const out = { ...result };
    for (const key of ['bindings', 'roleFindings', 'actions', 'emptyTables', '_hints']) {
        if (Array.isArray(out[key])) out[key] = [...out[key]].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return out;
}

function dataOpts(entry) {
    if (!entry.dataModel) return {};
    return { dataModel: entry.dataModel, datasets: (entry.datasets || []).map((d) => d.id).filter((id) => typeof id === 'string') };
}

for (const name of APPS) {
    test(`${name}: the same findings whatever the key order`, async () => {
        const entry = readCorpus(name);
        const canonical = canonicalOf(entry.definition);
        const opts = dataOpts(entry);
        const expected = validateAppDefinition(canonical, opts);
        const dryExpected = await appDryRun({ def: canonical, dataModel: opts.dataModel ?? null, datasets: opts.datasets ?? [] });
        for (const [label, order] of [['reversed', reversed], ['jsonb', jsonb]]) {
            const def = rekey(canonical, order);
            assert.notEqual(JSON.stringify(def), JSON.stringify(canonical), `${name}: the ${label} order differs from the canonical one`);
            const actual = validateAppDefinition(def, opts);
            assert.deepStrictEqual({ errors: actual.errors, warnings: actual.warnings }, { errors: expected.errors, warnings: expected.warnings }, `${name}: validate, ${label} keys`);
            const dry = await appDryRun({ def, dataModel: opts.dataModel ?? null, datasets: opts.datasets ?? [] });
            assert.deepStrictEqual(settled(dry), settled(dryExpected), `${name}: appDryRun, ${label} keys`);
        }
    });
}

test('sameJsonValue: equal JSON whatever the key order, arrays in order', () => {
    assert.equal(sameJsonValue({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }), true);
    assert.equal(sameJsonValue([1, 2], [2, 1]), false);
    assert.equal(sameJsonValue({ a: 1, b: undefined }, { a: 1 }), true, 'a key JSON leaves out is absent');
    assert.equal(sameJsonValue([undefined], [null]), true, 'an array slot JSON writes as null');
    assert.equal(sameJsonValue({ a: 1 }, { a: '1' }), false);
    assert.equal(sameJsonValue({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(sameJsonValue({}, []), false);
    assert.equal(sameJsonValue(null, {}), false);
});
