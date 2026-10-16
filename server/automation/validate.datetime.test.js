/**
 * Validation of the datetime step's optional timezone and epochUnit fields.
 * Run: node --test automation/validate.datetime.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('./validate');

const mk = (extra) => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [{ id: 's1', type: 'datetime', op: 'now', ...extra }],
    edges: [{ from: 'trg', to: 's1' }],
});

test('a valid timezone and epochUnit pass', () => {
    assert.strictEqual(validateDefinition(mk({ timezone: 'Europe/Amsterdam', epochUnit: 'seconds' })).ok, true);
});

test('an unknown timezone is an error', () => {
    assert.ok(validateDefinition(mk({ timezone: 'Mars/Base' })).errors.some((e) => e.code === 'datetime.timezone_invalid'));
});

test('an unknown epochUnit is an error', () => {
    assert.ok(validateDefinition(mk({ epochUnit: 'hours' })).errors.some((e) => e.code === 'datetime.epoch_unit_invalid'));
});
