'use strict';
/**
 * The Teams setup limits: unset or empty is the default, a non-negative number
 * is floored, garbage is the default, and 0 means unlimited.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/limits.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const limits = require('./limits.mts');

const NAMES = [
    'TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS', 'TEAMS_DIAGNOSTICS_PROBE_TIMEOUT_MS',
    'TEAMS_DIAGNOSTICS_MAX_MEMBERS', 'TEAMS_APP_IMPORT_MAX_SELECTED_USERS', 'TEAMS_APP_IMPORT',
];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
test.afterEach(() => {
    for (const n of NAMES) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
    }
});

test('the defaults when nothing is set', () => {
    for (const n of NAMES) delete process.env[n];
    assert.equal(limits.minIntervalSeconds(), 10);
    assert.equal(limits.probeTimeoutMs(), 15000);
    assert.equal(limits.maxMembers(), 2000);
    assert.equal(limits.maxSelectedUsers(), 5000);
    assert.equal(limits.appImportAllowed(), true);
});

test('an empty value is the default, a number is floored, 0 stays 0', () => {
    process.env.TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS = '';
    assert.equal(limits.minIntervalSeconds(), 10);
    process.env.TEAMS_DIAGNOSTICS_PROBE_TIMEOUT_MS = '2500.9';
    assert.equal(limits.probeTimeoutMs(), 2500);
    process.env.TEAMS_DIAGNOSTICS_MAX_MEMBERS = '0';
    assert.equal(limits.maxMembers(), 0, '0 = unlimited');
    process.env.TEAMS_APP_IMPORT_MAX_SELECTED_USERS = '12';
    assert.equal(limits.maxSelectedUsers(), 12);
});

test('negative or non-numeric values fall back to the default', () => {
    process.env.TEAMS_DIAGNOSTICS_MAX_MEMBERS = '-5';
    assert.equal(limits.maxMembers(), 2000);
    process.env.TEAMS_DIAGNOSTICS_PROBE_TIMEOUT_MS = 'soon';
    assert.equal(limits.probeTimeoutMs(), 15000);
    process.env.TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS = 'Infinity';
    assert.equal(limits.minIntervalSeconds(), 10);
    assert.equal(limits.limitFromEnv('TEAMS_NOT_A_REAL_VARIABLE', 7), 7);
});

test("TEAMS_APP_IMPORT switches option B off only for exactly '0'", () => {
    process.env.TEAMS_APP_IMPORT = '0';
    assert.equal(limits.appImportAllowed(), false);
    process.env.TEAMS_APP_IMPORT = 'false';
    assert.equal(limits.appImportAllowed(), true);
    process.env.TEAMS_APP_IMPORT = '1';
    assert.equal(limits.appImportAllowed(), true);
});
