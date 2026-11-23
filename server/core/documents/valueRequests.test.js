'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { addRequest, cancelRequest, recordFilled, requestsOf, filledByOf, isOpen } = require('./valueRequests.mts');

const now = '2026-11-20T10:00:00.000Z';
const later = '2026-11-20T11:00:00.000Z';
const base = { sampleValues: {} };
const ask = (settings, over = {}) => addRequest(settings, {
    id: 'r1', fields: ['iban', 'kvk'], assigneeId: 'bob', requestedBy: 'alice', message: 'Can you fill these in?', now, knownKeys: ['iban', 'kvk', 'name'], ...over,
});

test('a request names known fields of the document, once each', () => {
    const s = ask(base, { fields: ['iban', 'iban', 'nonsense', 'kvk'] });
    const [r] = requestsOf(s);
    assert.deepEqual(r.fields, ['iban', 'kvk']);
    assert.equal(r.assigneeId, 'bob');
    assert.equal(isOpen(r), true);
    assert.throws(() => ask(base, { fields: ['nonsense'] }), (e) => e.status === 422 && e.errorClass === 'value_request_no_fields');
});

test('a request is done once every field it asks for has a value, whoever filled it in', () => {
    let s = ask(base);
    const first = recordFilled(s, { iban: 'NL91ABNA0417164300' }, ['iban'], { userId: 'bob', now: later });
    assert.equal(first.completed.length, 0);
    assert.deepEqual(filledByOf(first.settings).iban, { userId: 'bob', at: later });
    s = first.settings;
    const second = recordFilled(s, { iban: 'NL91ABNA0417164300', kvk: '12345678' }, ['kvk'], { userId: 'carol', now: later });
    assert.equal(second.completed.length, 1);
    assert.equal(second.completed[0].doneAt, later);
    assert.equal(isOpen(requestsOf(second.settings)[0]), false);
    assert.equal(filledByOf(second.settings).kvk.userId, 'carol');
});

test('clearing a field forgets who filled it in', () => {
    const s = recordFilled(base, { name: 'X' }, ['name'], { userId: 'bob', now: now }).settings;
    assert.equal(filledByOf(recordFilled(s, { name: '' }, ['name'], { userId: 'bob', now: later }).settings).name, undefined);
});

test('only who asked, or who was asked, closes a request', () => {
    const s = ask(base);
    assert.throws(() => cancelRequest(s, 'r1', 'mallory', later), (e) => e.status === 403);
    const out = cancelRequest(s, 'r1', 'bob', later);
    assert.equal(out.request.cancelledAt, later);
    assert.equal(isOpen(requestsOf(out.settings)[0]), false);
    assert.equal(cancelRequest(out.settings, 'r1', 'alice', later).request, null, 'a closed request stays closed');
});
