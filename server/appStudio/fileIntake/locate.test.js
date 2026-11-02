'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compilePoPattern } = require('./locate');
const { classify } = require('./naming');

test('compilePoPattern: an overlapping alternation runs in linear time on a long filename', () => {
    const po = compilePoPattern({ poPattern: '(a|aa)+$' });
    const name = 'a'.repeat(60) + '!';
    const started = process.hrtime.bigint();
    const result = po.test(name);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.strictEqual(result, false);
    assert.ok(ms < 100, `took ${ms} ms`);
    assert.strictEqual(classify(name + '.pdf', po), 'drawing');
});

test('compilePoPattern: the default pattern still classifies purchase orders, case-insensitive', () => {
    const po = compilePoPattern({});
    assert.strictEqual(classify('Inkoopbestelbon_PO24118.pdf', po), 'po');
    assert.strictEqual(classify('PURCHASE_ORDER_7.pdf', po), 'po');
    assert.strictEqual(classify('TN-1.pdf', po), 'drawing');
});

test('compilePoPattern: an author pattern matches; an invalid or nested one falls back to the default', () => {
    assert.strictEqual(compilePoPattern({ poPattern: '^ORD-\\d+' }).test('ord-12.pdf'), true);
    assert.strictEqual(compilePoPattern({ poPattern: '(' }).test('bestelbon.pdf'), true);
    assert.strictEqual(compilePoPattern({ poPattern: '(?=(a+)+)x' }).test('bestelbon.pdf'), true);
});
