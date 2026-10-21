'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { stripTestData, stripCapturedData, TEST_DATA_KEYS } = require('./testDataKeys');
const { buildExport, sanitizeImport } = require('../../automation/portability');
const { canonicalOf } = require('../../projects/stages/stagePayload');

const LEAK = 'synthetic-leak-0192';
const junk = () => Object.fromEntries(TEST_DATA_KEYS.map((k) => [k, [{ v: LEAK }]]));

function definition() {
    return {
        ...junk(),
        trigger: { id: 't', type: 'trigger', kind: 'manual', ...junk() },
        steps: [
            { id: 'a', type: 'code', code: 'return 1;', ...junk() },
            { id: 'loop', type: 'loop', ...junk(), body: [{ id: 'inner', type: 'code', code: 'return 2;', ...junk() }] },
            { id: 'par', type: 'parallel', branches: [[{ id: 'deep', type: 'code', code: 'return 3;', ...junk() }]] },
        ],
        layers: {
            one: { ...junk(), steps: [{ id: 'l1', type: 'code', code: 'return 4;', ...junk() }] },
        },
    };
}

const hasLeak = (v) => JSON.stringify(v).includes(LEAK);

test('stripTestData removes the keys at the root, on the trigger, on steps, in bodies, branches and layers', () => {
    const def = definition();
    const warnings = [];
    assert.strictEqual(stripTestData(def, warnings), def, 'the same definition comes back');
    assert.strictEqual(hasLeak(def), false);
    for (const k of TEST_DATA_KEYS) assert.ok(!(k in def));
    assert.strictEqual(def.steps[0].code, 'return 1;', 'everything else stays');
    assert.strictEqual(def.layers.one.steps[0].id, 'l1');
    assert.strictEqual(warnings.length, 1);
});

test('stripTestData is quiet when there is nothing to remove, and tolerates non-objects', () => {
    const warnings = [];
    stripTestData({ steps: [{ id: 'a', type: 'code' }] }, warnings);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(stripTestData(null), null);
    assert.strictEqual(stripTestData('x'), 'x');
});

test('stripCapturedData also removes the manual-trigger sample', () => {
    const def = { ...junk(), manualTriggerPayload: { subject: LEAK }, steps: [] };
    const warnings = [];
    stripCapturedData(def, warnings);
    assert.deepStrictEqual(def, { steps: [] });
    assert.strictEqual(warnings.length, 2);
});

test('buildExport carries no test data and says it removed some', () => {
    const { envelope, warnings } = buildExport({ title: 'T', definition: { ...definition(), manualTriggerPayload: { subject: LEAK } } });
    assert.strictEqual(hasLeak(envelope), false);
    assert.ok(warnings.some((w) => /sample payload/i.test(w)));
    assert.ok(warnings.some((w) => /test data/i.test(w)));
});

test('sanitizeImport drops test data a hand-edited file carries', () => {
    const { automation, errors } = sanitizeImport({
        format: 'beeflow.automation', schemaVersion: 1, automation: { title: 'T', definition: definition() },
    });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(hasLeak(automation.definition), false);
});

test('the stage payload of an automation and of a block carries no test data, and hashes the same with or without', () => {
    for (const kind of ['automation', 'block']) {
        const withData = canonicalOf(kind, { title: 'T', definition: definition() });
        assert.strictEqual(hasLeak(withData), false, kind);
        const clean = definition();
        stripTestData(clean);
        assert.deepStrictEqual(withData, canonicalOf(kind, { title: 'T', definition: clean }));
    }
});
