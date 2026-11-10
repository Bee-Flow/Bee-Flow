'use strict';
/**
 * One diagnostics run per user per interval; 0 switches the brake off.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/rateLimit.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { takeDiagnosticsSlot, resetDiagnosticsSlots } = require('./rateLimit.mts');

const saved = process.env.TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS;
test.afterEach(() => {
    resetDiagnosticsSlots();
    if (saved === undefined) delete process.env.TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS;
    else process.env.TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS = saved;
});

test('a second run inside the interval is refused, after it allowed again', () => {
    delete process.env.TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS;
    assert.equal(takeDiagnosticsSlot('u1', 1_000), true);
    assert.equal(takeDiagnosticsSlot('u1', 5_000), false, '4 s later, default 10 s');
    assert.equal(takeDiagnosticsSlot('u2', 5_000), true, 'another user has their own slot');
    assert.equal(takeDiagnosticsSlot('u1', 11_000), true, '10 s later');
});

test('a refused attempt does not extend the wait', () => {
    process.env.TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS = '10';
    assert.equal(takeDiagnosticsSlot('u1', 0), true);
    assert.equal(takeDiagnosticsSlot('u1', 9_000), false);
    assert.equal(takeDiagnosticsSlot('u1', 10_000), true);
});

test('0 means no limit', () => {
    process.env.TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS = '0';
    assert.equal(takeDiagnosticsSlot('u1', 0), true);
    assert.equal(takeDiagnosticsSlot('u1', 1), true);
});

test('the map stays bounded', () => {
    process.env.TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS = '1000';
    for (let i = 0; i < 10_050; i++) takeDiagnosticsSlot(`user-${i}`, i);
    assert.equal(takeDiagnosticsSlot('user-10049', 10_051), false, 'the newest entry is kept');
    assert.equal(takeDiagnosticsSlot('user-0', 10_052), true, 'the oldest entry was dropped');
});
