// @typecheck
/**
 * The per-user config stems: erasure covers every settings secret and the
 * other per-user keys, once each.
 *
 * Run: cd server && node --test stores/user/userSecretKeys.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SECRETS, perUserConfigStems } = require('./userSecretKeys.mts');

test('erasure stems include every settings secret and the other per-user keys, without duplicates', () => {
    const stems = perUserConfigStems();
    for (const stem of Object.values(SECRETS)) assert.ok(stems.includes(stem), stem);
    for (const stem of ['github_token', 'linkedin_access_token', 'enabled_apps', 'memory_enabled']) assert.ok(stems.includes(stem), stem);
    assert.equal(new Set(stems).size, stems.length);
    assert.ok(Object.isFrozen(SECRETS));
});
