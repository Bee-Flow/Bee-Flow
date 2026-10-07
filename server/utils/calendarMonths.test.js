'use strict';

/**
 * addCalendarMonths — a month is a calendar month, clamped to the end of a
 * short target month (Reg. 1182/71 Art. 3(2)(c)), never an overflow.
 *
 * Run: cd server && node --test utils/calendarMonths.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { addCalendarMonths } = require('./calendarMonths');

const iso = (d) => d.toISOString();

test('an ordinary month keeps the day and the time of day', () => {
    assert.equal(iso(addCalendarMonths('2027-03-05T09:30:00.000Z', 1)), '2027-04-05T09:30:00.000Z');
    assert.equal(iso(addCalendarMonths(new Date('2026-09-10T10:00:00.000Z'), 1)), '2026-10-10T10:00:00.000Z');
});

test('a day the target month does not have clamps to its last day (no overflow into the next month)', () => {
    assert.equal(iso(addCalendarMonths('2027-01-31T12:00:00.000Z', 1)), '2027-02-28T12:00:00.000Z');
    assert.equal(iso(addCalendarMonths('2028-01-31T12:00:00.000Z', 1)), '2028-02-29T12:00:00.000Z', 'leap year');
    assert.equal(iso(addCalendarMonths('2027-01-31T12:00:00.000Z', 3)), '2027-04-30T12:00:00.000Z');
    assert.equal(iso(addCalendarMonths('2026-12-31T00:00:00.000Z', 2)), '2027-02-28T00:00:00.000Z', 'across a year end');
});

test('negative months count backwards with the same clamp', () => {
    assert.equal(iso(addCalendarMonths('2026-08-31T00:00:00.000Z', -6)), '2026-02-28T00:00:00.000Z');
    assert.equal(iso(addCalendarMonths('2027-03-01T00:00:00.000Z', -6)), '2026-09-01T00:00:00.000Z');
});

test('the input is not mutated', () => {
    const d = new Date('2027-01-31T00:00:00.000Z');
    addCalendarMonths(d, 1);
    assert.equal(iso(d), '2027-01-31T00:00:00.000Z');
});
