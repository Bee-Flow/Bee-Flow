// @typecheck strict
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { translate, normaliseLocale } = require('./translate');

const strings = { 'project_collab.bell.removed.title': 'Je bent uit een project gehaald', 'project_collab.bell.left.message': '{actor} verliet "{project}".' };
const getStrings = async (/** @type {string} */ code) => (code === 'nl' ? strings : {});

test('the locale value wins, with placeholders filled', async () => {
    assert.strictEqual(await translate('nl', 'project_collab.bell.left.message', { actor: 'Ann', project: 'Launch' }, { getStrings }), 'Ann verliet "Launch".');
});

test('an unknown key comes back as the key', async () => {
    assert.strictEqual(await translate('en', 'no.such.key', {}, { getStrings }), 'no.such.key');
});

test('a locale with a region, or garbage, is normalised', async () => {
    assert.strictEqual(normaliseLocale('NL-nl'), 'nl');
    assert.strictEqual(normaliseLocale(undefined), 'en');
    assert.strictEqual(await translate('nl-NL', 'project_collab.bell.removed.title', {}, { getStrings }), 'Je bent uit een project gehaald');
});

// The fallbacks to the English dictionary are pinned on the projects module's bell strings
// (project_collab.*): translate.projects.test.js.
