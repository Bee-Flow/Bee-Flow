/**
 * The apps module's half of en.discovery.test.js: its App Studio schema namespace
 * (en/studio_apps_schema.js) is found and merged without a NAMESPACES entry.
 *
 * Run: node --test i18n/defaults/en.discovery.apps.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { GUI_DEFAULTS, DISCOVERED_NAMESPACES } = require('./en');

test('the App Studio schema namespace is found without a NAMESPACES entry', () => {
    assert.ok(DISCOVERED_NAMESPACES.includes('studio_apps_schema'));
    assert.ok(GUI_DEFAULTS['studio_apps_schema.newer_than_install']);
});
