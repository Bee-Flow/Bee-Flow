/**
 * Formula values in a dataset binding's `params`: checked (so a variable they
 * read counts as used), but a problem is a warning, never an error, because
 * such values were stored and ignored before datasets had parameters.
 *
 * Run: cd server && node --test appStudio/validate.datasetParams.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');

function defWith(params) {
    return canonicalizeAppDefinition({
        schemaVersion: 2,
        meta: { name: 'P' },
        homeScreenId: 'scr_home01',
        variables: [{ name: 'region', type: 'text', default: 'north' }],
        screens: [{
            id: 'scr_home01', name: 'Home',
            sections: [{ id: 'sec_main01', style: {}, children: [{ id: 'cmp_stat01', type: 'stat', props: { label: 'T', value: { kind: 'dataset', datasetId: 'ds_1', params } } }] }],
        }],
        actions: {},
    }).def;
}
const opts = { datasets: [{ id: 'ds_1' }] };
const codes = (list) => list.map((f) => f.code);

test('a formula param that reads a variable counts as a use of it', () => {
    const res = validateAppDefinition(defWith({ region: { kind: 'formula', expr: 'vars.region' } }), opts);
    assert.deepStrictEqual(res.errors, []);
    assert.ok(!codes(res.warnings).includes('variable.unused'), JSON.stringify(res.warnings));
});

test('a formula param that does not parse is a warning, not an error', () => {
    const res = validateAppDefinition(defWith({ region: { kind: 'formula', expr: '((' }, n: 3 }), opts);
    assert.deepStrictEqual(res.errors, []);
    const parse = res.warnings.find((w) => w.code === 'formula.parse_error');
    assert.ok(parse, JSON.stringify(res.warnings));
    assert.strictEqual(parse.severity, 'warning');
    assert.ok(parse.path.endsWith('.params.region.expr'), parse.path);
});
