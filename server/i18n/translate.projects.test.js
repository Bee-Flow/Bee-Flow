// @typecheck strict
'use strict';
/**
 * The projects module's half of translate.test.js: the fallbacks of translate() to the English
 * dictionary, pinned on that module's bell strings (project_collab.bell.*). What needs no English
 * text (the unknown key, the locale normalisation, the Dutch value) is in translate.test.js.
 *
 * Run: cd server && node --test i18n/translate.projects.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { translate } = require('./translate');

const strings = { 'project_collab.bell.removed.title': 'Je bent uit een project gehaald', 'project_collab.bell.left.message': '{actor} verliet "{project}".' };
const getStrings = async (/** @type {string} */ code) => (code === 'nl' ? strings : {});

test('a missing value falls back to English', async () => {
    assert.strictEqual(await translate('nl', 'project_collab.bell.added.title', {}, { getStrings }), 'You were added to a project');
});

test('a failing store falls back to English', async () => {
    assert.strictEqual(await translate('nl', 'project_collab.bell.removed.title', {}, { getStrings: async () => { throw new Error('db'); } }), 'You were removed from a project');
});

test('a placeholder without a value stays visible rather than becoming "undefined"', async () => {
    assert.strictEqual(await translate('en', 'project_collab.bell.left.message', { actor: 'Ann' }, { getStrings }), 'Ann left "{project}".');
});
