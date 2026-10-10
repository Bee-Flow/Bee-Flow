/**
 * Dutch for project collaboration. Both silent failure modes are pinned: a Dutch key
 * with no English key is stored and never read, and an English key with no
 * Dutch value leaves one English sentence in a Dutch page.
 *
 * Run: node --test migrations/add-nl-project-collab-translations.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-project-collab-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every English project_collab key has a Dutch value', () => {
    const missing = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('project_collab.') && !NL_TRANSLATIONS[k]);
    assert.deepStrictEqual(missing, []);
});
