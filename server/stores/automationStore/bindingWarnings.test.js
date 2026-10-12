/**
 * What a run-step row keeps of the mappings that found nothing
 * (persistableBindingWarnings): an allow-list of the binding log's fields,
 * each through the same redaction as the step's error, plus the server's own
 * sentence. Pure, no DB.
 *
 * Run: cd server && node --test stores/automationStore/bindingWarnings.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { persistableBindingWarnings, MAX_STORED_WARNINGS } = require('./bindingWarnings');
const { redactForPersistence } = require('../../automation/runLogRedaction');

const MISS = {
    field: 'to', kind: 'ref', path: 'steps.http.output.data.contact.e-mail', reason: 'missing',
    at: 'steps.http.output.data.contact', found: 'record', missing: 'e-mail', count: 3,
};

test('nothing missed is null, not an empty list', () => {
    assert.equal(persistableBindingWarnings(null), null);
    assert.equal(persistableBindingWarnings(undefined), null);
    assert.equal(persistableBindingWarnings([]), null);
    assert.equal(persistableBindingWarnings('steps.a.output.x'), null);
    assert.equal(persistableBindingWarnings([null, 'x', 42]), null, 'no well-formed entry at all');
});

test('an entry keeps its fields and gains the server sentence', () => {
    const [w] = persistableBindingWarnings([MISS]);
    assert.deepEqual(w, {
        ...MISS,
        description: 'input "to" read steps.http.output.data.contact.e-mail, but steps.http.output.data.contact has no "e-mail" (3×)',
    });
});

test('only allow-listed fields are kept: a key the log grows later does not ride along', () => {
    const [w] = persistableBindingWarnings([{ ...MISS, value: 'ann@example.com', stepId: 's1', raw: { a: 1 } }]);
    assert.ok(!('value' in w));
    assert.ok(!('stepId' in w));
    assert.ok(!('raw' in w));
});

test('ill-typed fields are dropped, an unknown reason reads as missing, count defaults to 1', () => {
    const [w] = persistableBindingWarnings([{
        field: 7, kind: 'sql', path: 'steps.a.output.x', reason: 'weird', size: -1, index: 'yes', count: 0, found: { x: 1 },
    }]);
    assert.deepEqual(
        Object.fromEntries(Object.entries(w).filter(([k]) => k !== 'description')),
        { path: 'steps.a.output.x', reason: 'missing', count: 1 },
    );
    // An entry without a path says nothing a person can act on.
    assert.equal(persistableBindingWarnings([{ field: 'to', reason: 'missing' }]), null);
});

test('long strings are capped, and the list itself is capped', () => {
    const [w] = persistableBindingWarnings([{ ...MISS, message: 'x'.repeat(5000), path: `steps.a.output.${'k'.repeat(5000)}` }]);
    assert.ok(w.message.length <= 500);
    assert.ok(w.path.length <= 1000);
    const many = Array.from({ length: MAX_STORED_WARNINGS + 10 }, (_, i) => ({ ...MISS, field: `f${i}` }));
    assert.equal(persistableBindingWarnings(many).length, MAX_STORED_WARNINGS);
});

test('every string goes through the caller\'s redaction, and so does the sentence', () => {
    const key = 'sk-abcdefghijklmnop1234';
    const clean = (v) => redactForPersistence(v, { secretValues: [] }).value;
    const [w] = persistableBindingWarnings([{
        field: 'auth', kind: 'expr', path: `concat("${key}", steps.a.output.x)`, reason: 'error', message: `bad key ${key}`,
    }], { clean });
    assert.ok(!JSON.stringify(w).includes(key), 'the key is masked everywhere, the sentence included');
    assert.match(w.description, /formula/);
});
