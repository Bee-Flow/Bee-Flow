/** Run: node --test core/automationRunner/layerParams.test.js */
const test = require('node:test');
const assert = require('node:assert');
const { coerceLayerInputs } = require('./layerParams');

const layer = { trigger: { params: [{ name: 'qty', type: 'number' }, { name: 'n', type: 'integer' }, { name: 'who', type: 'string' }] } };

test('a numeric string becomes a number; other params pass through', () => {
    assert.deepStrictEqual(coerceLayerInputs(layer, { qty: '5', who: '7', n: 2 }, 'c1'), { qty: 5, who: '7', n: 2 });
});

test('an empty or absent number param is left alone', () => {
    assert.deepStrictEqual(coerceLayerInputs(layer, { qty: '' }, 'c1'), { qty: '' });
    assert.deepStrictEqual(coerceLayerInputs(layer, {}, 'c1'), {});
});

test('a non-numeric value fails naming the parameter, never the value', () => {
    assert.throws(() => coerceLayerInputs(layer, { qty: 'abc-private' }, 'c1'), (e) => {
        assert.strictEqual(e.errorClass, 'ValidationError');
        assert.match(e.message, /"qty"/);
        assert.doesNotMatch(e.message, /abc-private/);
        return true;
    });
    assert.throws(() => coerceLayerInputs(layer, { n: 1.5 }, 'c1'), /"n".*whole number/);
});

test('a layer without params changes nothing', () => {
    assert.deepStrictEqual(coerceLayerInputs({}, { a: 'x' }, 'c1'), { a: 'x' });
});
