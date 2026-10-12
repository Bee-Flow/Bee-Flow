/**
 * Dutch for the project chat composer. Both silent failure modes are pinned: a Dutch key
 * with no English key is stored and never read, and an English key with no
 * Dutch value leaves one English sentence in a Dutch page.
 *
 * Run: node --test migrations/add-nl-project-golf4-translations.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-project-golf4-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');
const { NL_TRANSLATIONS: BOOT_LIST } = require('../boot/bootMigrations');

test('every Dutch key has an English key', () => {
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
});

test('every new English project_chat key has a Dutch value', () => {
    const missing = ['project_chat.composer_label', 'project_chat.new_composer_label'].filter((k) => !NL_TRANSLATIONS[k] || !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(missing, []);
});

test('placeholders survive translation', () => {
    const vars = (s) => (String(s).match(/\{\w+\}/g) || []).sort();
    for (const [key, nl] of Object.entries(NL_TRANSLATIONS)) assert.deepStrictEqual(vars(nl), vars(GUI_DEFAULTS[key]), key);
});

test('it runs at boot', () => {
    assert.ok(BOOT_LIST.includes('add-nl-project-golf4-translations'));
});
