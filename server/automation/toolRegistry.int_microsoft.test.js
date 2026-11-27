// @typecheck
/**
 * The int_microsoft module's half of toolRegistry.test.js: `outlook-readonly`, the entry that
 * shares its tool names with `outlook`, declares that it does.
 *
 * Run: node --test automation/toolRegistry.int_microsoft.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { appEntryFor } = require('./toolRegistry');

test('outlook-readonly is de bekende gedeelde entry, en is als zodanig gedeclareerd', () => {
    // Not a "the list contains X" pin: this is the entry on which the finding sat, and the declaration is what
    // takes it out of the silent-dead-grant state.
    const ro = appEntryFor('outlook-readonly');
    assert.ok(ro, 'outlook-readonly hoort in het registry te staan');
    assert.strictEqual(ro.grantsVia, 'outlook');
    assert.strictEqual(ro.module, appEntryFor('outlook').module, 'dezelfde module, dezelfde namen');
});
