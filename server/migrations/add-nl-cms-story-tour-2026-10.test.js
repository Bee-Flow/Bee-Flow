/**
 * Pins: every English key of the scroll story / tour editors has a Dutch
 * one, and no Dutch key lacks an English twin (it would be stored and never read).
 *
 * Run: node --test migrations/add-nl-cms-story-tour-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-cms-story-tour-2026-10');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED = /^cms_site\.blocks\.(story_media|scroll_story|tour)\./;

test('every English key of these editors has a Dutch one', () => {
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => OWNED.test(k) && !(k in NL_TRANSLATIONS));
    assert.deepStrictEqual(untranslated, []);
});

test('every Dutch key has an English twin', () => {
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
});
