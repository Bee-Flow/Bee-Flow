'use strict';

/**
 * readinessCounts — a control whose only check is not_applicable (a connector
 * that is not enabled) is unchecked, never verified; a pass next to a
 * not_applicable still verifies; a fail wins; a warn is the remainder.
 *
 * Run: cd server && node --test compliance/iso/readiness.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { readinessCounts } = require('./readiness');

test('a control whose only check is not applicable is unchecked, not verified', () => {
    assert.deepEqual(
        readinessCounts([{ ref: 'A.5.14' }], { 'A.5.14': ['ISO27001-A.5.14-mail-security'] }, { 'ISO27001-A.5.14-mail-security': 'not_applicable' }),
        { verified: 0, failing: 0, unchecked: 1 });
});

test('pass, fail, warn and no result', () => {
    const controls = [{ ref: 'P' }, { ref: 'F' }, { ref: 'W' }, { ref: 'N' }];
    const checks = { P: ['p', 'na'], F: ['p', 'f'], W: ['w'], N: ['missing'] };
    const status = { p: 'pass', na: 'not_applicable', f: 'fail', w: 'warn' };
    assert.deepEqual(readinessCounts(controls, checks, status), { verified: 1, failing: 1, unchecked: 1 });
});
