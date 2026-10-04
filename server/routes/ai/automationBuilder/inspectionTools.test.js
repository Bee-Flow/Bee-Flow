const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect, maskedRunValues } = require('./inspectionTools');
const { tokenizeText } = require('../../../core/privacy/piiDetection/tokenizer');

test('run inspection masks personal values and leaves useful non-personal numbers intact', async () => {
    const values = { email: 'person@example.test', amount: 1234.56, lines: [{ contact: 'person@example.test' }] };
    const result = await maskedRunValues(values, { tokenizeText, detectPii: async () => ({ hasPii: true, entities: [{ text: 'person@example.test', label: 'Email', score: 1 }] }) });
    assert.equal(result.valuesAvailable, true);
    assert.equal(result.values.amount, 1234.56);
    assert.ok(!JSON.stringify(result).includes('person@example.test'));
    assert.equal(result.values.email, result.values.lines[0].contact);
});

test('absent, degraded or failed scanners return only shapes, never raw values', async () => {
    for (const detectPii of [async () => null, async () => ({ degraded: true }), async () => { throw new Error('unavailable'); }]) {
        const result = await maskedRunValues({ private: 'person@example.test', identifier: 123456789 }, { detectPii, tokenizeText });
        assert.equal(result.valuesAvailable, false);
        assert.ok(!JSON.stringify(result).includes('person@example.test'));
        assert.ok(!JSON.stringify(result).includes('123456789'));
    }
});

test('inspection only reads runs belonging to the automation owner', async () => {
    let readRun = false;
    const result = await inspect('builder_inspect_run', { stepId: 's1' }, { automationId: 'a1', userId: 'owner', def: { steps: [{ id: 's1' }] } }, {
        store: { getAutomation: async () => ({ userId: 'someoneElse' }), listRunsForAutomation: async () => { readRun = true; } }, pii: {},
    });
    assert.match(result.error, /owner/);
    assert.equal(readRun, false);
});
