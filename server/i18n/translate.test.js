// @typecheck strict
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { translate } = require('./translate');

const strings = { 'project_collab.bell.removed.title': 'Je bent uit een project gehaald', 'project_collab.bell.left.message': '{actor} verliet "{project}".' };
const getStrings = async (/** @type {string} */ code) => (code === 'nl' ? strings : {});

test('the locale value wins, with placeholders filled', async () => {
    assert.strictEqual(await translate('nl', 'project_collab.bell.left.message', { actor: 'Ann', project: 'Launch' }, { getStrings }), 'Ann verliet "Launch".');
});

// The fallbacks to the English dictionary are pinned on the projects module's bell strings
// (project_collab.*): translate.projects.test.js.
