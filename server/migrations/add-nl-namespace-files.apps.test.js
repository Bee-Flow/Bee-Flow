// @typecheck strict
/**
 * The apps module's half of add-nl-namespace-files.test.js: the catalogue that seeds
 * server/i18n/defaults/nl/<namespace>.json seeds the App Studio schema namespace
 * (i18n/defaults/nl/studio_apps_schema.json, the apps module's file).
 *
 * Run: node --test migrations/add-nl-namespace-files.apps.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-namespace-files');

test('it seeds the App Studio schema namespace', () => {
    assert.ok(NL_TRANSLATIONS['studio_apps_schema.newer_than_install'], 'the App Studio schema namespace is seeded');
});
