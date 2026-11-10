/**
 * assertGeneric500 and textWithoutCorrelationId (testUtils/routeHarness.js).
 *
 * A leak check runs a pattern such as /db-primary|5432/ over an error answer.
 * The answer carries a correlationId, a random UUID, which can hold those very
 * digits: checked over the whole body, a correct answer fails once in a while.
 * The helper checks everything except the id.
 *
 * Run: cd server && node --test testUtils/routeHarness.generic500.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { assertGeneric500, textWithoutCorrelationId } = require('./routeHarness');

const LEAKS = /terminating|db-primary|5432/;
const answer = (body, status = 500) => ({ status, body, text: JSON.stringify(body) });

test('a correlationId that happens to contain the digits is not a leak', () => {
    const res = answer({ error: 'Internal server error', correlationId: 'bc543279-593c-439b-bfd6-e469b0ce8c23' });
    assert.match(res.text, LEAKS, 'the whole body does match: that is the false alarm');
    assertGeneric500(assert, res, LEAKS);
});

test('the same digits anywhere else in the body are a leak', () => {
    const res = answer({ error: 'Internal server error', correlationId: 'aaaaaaaa-0000-4000-8000-000000000000', detail: 'db-primary.internal:5432' });
    assert.throws(() => assertGeneric500(assert, res, LEAKS), { code: 'ERR_ASSERTION' });
});

test('a 500 with another sentence, or without an id, is not the generic one', () => {
    assert.throws(() => assertGeneric500(assert, answer({ error: 'terminating connection', correlationId: 'x' }), LEAKS), { code: 'ERR_ASSERTION' });
    assert.throws(() => assertGeneric500(assert, answer({ error: 'Internal server error' }), LEAKS), { code: 'ERR_ASSERTION' });
    assert.throws(() => assertGeneric500(assert, answer({ error: 'Internal server error', correlationId: 'x' }, 502), LEAKS), { code: 'ERR_ASSERTION' });
});

test('textWithoutCorrelationId keeps every other field, and a body that is not an object as it is', () => {
    assert.strictEqual(textWithoutCorrelationId(answer({ error: 'Invalid id', code: 'bad', correlationId: '5432' }, 400)), '{"error":"Invalid id","code":"bad"}');
    assert.strictEqual(textWithoutCorrelationId({ status: 500, body: null, text: 'upstream 5432' }), 'upstream 5432');
});
