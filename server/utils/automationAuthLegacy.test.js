/**
 * The legacy-fallback switch: the new name wins, the old one still counts.
 *
 * Run: cd server && node --test utils/automationAuthLegacy.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { automationAuthLegacy } = require('./automationAuthLegacy');

function withEnv(env, fn) {
    const saved = { a: process.env.AUTOMATION_AUTH_LEGACY, r: process.env.ROUTINE_AUTH_LEGACY };
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { return fn(); } finally {
        for (const [k, v] of [['AUTOMATION_AUTH_LEGACY', saved.a], ['ROUTINE_AUTH_LEGACY', saved.r]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

test('the new name decides when it is set', () => {
    assert.equal(withEnv({ AUTOMATION_AUTH_LEGACY: '1', ROUTINE_AUTH_LEGACY: '0' }, automationAuthLegacy), '1');
});

test('an install that turned the fallback off under the old name keeps it off', () => {
    assert.equal(withEnv({ AUTOMATION_AUTH_LEGACY: undefined, ROUTINE_AUTH_LEGACY: '0' }, automationAuthLegacy), '0');
});

test('neither set means the default (undefined)', () => {
    assert.equal(withEnv({ AUTOMATION_AUTH_LEGACY: undefined, ROUTINE_AUTH_LEGACY: undefined }, automationAuthLegacy), undefined);
});
