// @typecheck
/**
 * The notebooks module's half of toolRegistry.test.js: its inline app (`workspace`, the
 * notebook tools) answers to the checks of every inline app.
 *
 * Run: node --test automation/toolRegistry.notebooks.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { INLINE_TOOL_APPS } = require('./toolRegistry');
const { assertInlineApp, NOTEBOOKS_INLINE_APP } = require('./toolRegistry.testkit');

test('de notebooks-app laadt echt tools, en zegt hoe een "niet beschikbaar" gelezen moet worden', () => {
    const entry = INLINE_TOOL_APPS.find((e) => e.app === NOTEBOOKS_INLINE_APP);
    assert.ok(entry, `${NOTEBOOKS_INLINE_APP} is no inline app`);
    assertInlineApp(entry);
});
