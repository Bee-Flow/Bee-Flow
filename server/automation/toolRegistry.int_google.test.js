// @typecheck
/**
 * The int_google module's half of toolRegistry.test.js: appEntryFor finds a registry app of
 * this module.
 *
 * Run: node --test automation/toolRegistry.int_google.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { appEntryFor } = require('./toolRegistry');

test('appEntryFor vindt inline apps net zo goed als registry-apps', () => {
    assert.strictEqual(appEntryFor('gmail')?.arrayName, 'GMAIL_TOOLS');
});
