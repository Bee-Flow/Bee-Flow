'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toImageLimits, resolveEffectiveImageLimits, exceededImageWindow, isValidImageLimit } = require('./imageLimit.mts');

const counts = (over = {}) => ({ hour: 0, day: 0, week: 0, month: 0, ...over });

test('a stored JSON text and an object give the same limits', () => {
    assert.deepEqual(toImageLimits('{"hour":5,"day":20}'), { hour: 5, day: 20 });
    assert.deepEqual(toImageLimits({ week: 100, month: '400' }), { week: 100, month: 400 });
});

test('nothing usable gives null', () => {
    for (const v of [null, undefined, '', '   ', 'not json', '[]', [], 7, {}, { hour: -1 }, { day: 1.5 }, { week: 'abc' }, { other: 3 }]) {
        assert.equal(toImageLimits(v), null);
    }
});

test('a damaged window is dropped, the others stay', () => {
    assert.deepEqual(toImageLimits({ hour: -2, day: 10, month: Infinity }), { day: 10 });
});

test('only whole numbers from zero up are valid', () => {
    assert.equal(isValidImageLimit(0), true);
    assert.equal(isValidImageLimit(25), true);
    assert.equal(isValidImageLimit(2.5), false);
    assert.equal(isValidImageLimit(-1), false);
    assert.equal(isValidImageLimit('5'), false);
    assert.equal(isValidImageLimit(1_000_001), false);
});

test('the user\'s own window wins over group and organisation', () => {
    const limits = resolveEffectiveImageLimits({ userLimits: { day: 3 }, groupLimits: [{ day: 50 }], orgLimits: { day: 10 } });
    assert.deepEqual(limits, { day: 3 });
});

test('windows resolve one by one across the levels', () => {
    const limits = resolveEffectiveImageLimits({
        userLimits: { hour: 2 },
        groupLimits: [{ day: 10 }, { day: 25, week: 60 }],
        orgLimits: { hour: 9, day: 5, month: 300 },
    });
    assert.deepEqual(limits, { hour: 2, day: 25, week: 60, month: 300 });
});

test('zero on the user lifts the organisation default for that window only', () => {
    const limits = resolveEffectiveImageLimits({ userLimits: { day: 0 }, groupLimits: [], orgLimits: { day: 5, month: 100 } });
    assert.deepEqual(limits, { month: 100 });
});

test('a group without a limit beats a group with one', () => {
    const limits = resolveEffectiveImageLimits({ userLimits: null, groupLimits: [{ day: 10 }, { day: 0 }], orgLimits: { day: 5 } });
    assert.equal(limits, null);
});

test('no limits anywhere gives null', () => {
    assert.equal(resolveEffectiveImageLimits({ userLimits: null, groupLimits: [null, '{}'], orgLimits: undefined }), null);
});

test('below every limit nothing is exceeded', () => {
    assert.equal(exceededImageWindow({ hour: 5, day: 20 }, counts({ hour: 4, day: 19 })), null);
    assert.equal(exceededImageWindow(null, counts({ hour: 999 })), null);
});

test('the shortest used-up window is reported', () => {
    assert.deepEqual(
        exceededImageWindow({ hour: 5, day: 20, month: 30 }, counts({ hour: 5, day: 20, month: 30 })),
        { window: 'hour', limit: 5, used: 5 },
    );
    assert.deepEqual(
        exceededImageWindow({ hour: 5, month: 30 }, counts({ hour: 1, day: 31, week: 31, month: 31 })),
        { window: 'month', limit: 30, used: 31 },
    );
});
