'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { translate, normaliseLocale } = require('./translate');

const strings = { 'project_collab.bell.removed.title': 'Je bent uit een project gehaald', 'project_collab.bell.left.message': '{actor} verliet "{project}".' };
const getStrings = async (code) => (code === 'nl' ? strings : {});

test('the locale value wins, with placeholders filled', async () => {
    assert.strictEqual(await translate('nl', 'project_collab.bell.left.message', { actor: 'Ann', project: 'Launch' }, { getStrings }), 'Ann verliet "Launch".');
});

test('a missing value falls back to English, and an unknown key to the key', async () => {
    assert.strictEqual(await translate('nl', 'project_collab.bell.added.title', {}, { getStrings }), 'You were added to a project');
    assert.strictEqual(await translate('en', 'no.such.key', {}, { getStrings }), 'no.such.key');
});

test('a locale with a region, or garbage, is normalised; a failing store falls back to English', async () => {
    assert.strictEqual(normaliseLocale('NL-nl'), 'nl');
    assert.strictEqual(normaliseLocale(undefined), 'en');
    assert.strictEqual(await translate('nl-NL', 'project_collab.bell.removed.title', {}, { getStrings }), 'Je bent uit een project gehaald');
    assert.strictEqual(await translate('nl', 'project_collab.bell.removed.title', {}, { getStrings: async () => { throw new Error('db'); } }), 'You were removed from a project');
});

test('a placeholder without a value stays visible rather than becoming "undefined"', async () => {
    assert.strictEqual(await translate('en', 'project_collab.bell.left.message', { actor: 'Ann' }, { getStrings }), 'Ann left "{project}".');
});
