'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { imageLimits, storedImageLimits } = require('./schemaParts');

const schema = imageLimits();

test('whole numbers per window, null and absent are accepted', () => {
    for (const v of [undefined, null, {}, { hour: 5 }, { hour: 0, day: 20, week: 100, month: 400 }, { day: null }]) {
        assert.equal(schema.safeParse(v).success, true, JSON.stringify(v));
    }
});

test('anything else is refused in words', () => {
    for (const v of [{ hour: -1 }, { day: 1.5 }, { week: '10' }, { month: 1_000_001 }, { year: 3 }, [], 'x', 5]) {
        const check = schema.safeParse(v);
        assert.equal(check.success, false, JSON.stringify(v));
        assert.ok(check.error.issues[0].message.length > 10);
    }
});

test('what the store gets: only the set windows, null when none, undefined when not sent', () => {
    assert.equal(storedImageLimits(undefined), undefined);
    assert.equal(storedImageLimits(null), null);
    assert.equal(storedImageLimits({}), null);
    assert.equal(storedImageLimits({ hour: null }), null);
    assert.deepEqual(storedImageLimits({ hour: 0, day: 20, week: null }), { hour: 0, day: 20 });
});
