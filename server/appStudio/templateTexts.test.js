'use strict';

/**
 * The built-in templates' gallery texts in the i18n namespace studio_apps_templates_builtin:
 * every title, description and category has its key, the English there is the template's own
 * text (so the gallery reads the same in English, and a template edit that forgets the dictionary
 * fails here), and no key names a template that is not built in. The display layer translates
 * (agent-hub list/templateText.ts); the templates themselves are not touched.
 *
 * Run: cd server && node --test appStudio/templateTexts.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TEMPLATES } = require('./templates');
const EN = require('../i18n/defaults/en/studio_apps_templates_builtin');
const NL = require('../i18n/defaults/nl/studio_apps_templates_builtin.json');

const NS = 'studio_apps_templates_builtin';
/** The key part the gallery builds (agent-hub list/templateText.ts templateKeyPart). */
const part = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function expected() {
    const out = {};
    for (const t of TEMPLATES) {
        out[`${NS}.${part(t.id)}.title`] = t.title;
        out[`${NS}.${part(t.id)}.description`] = t.description;
        out[`${NS}.category.${part(t.category)}`] = t.category;
    }
    return out;
}

test('the English holds every built-in template text, word for word, and nothing else', () => {
    assert.deepEqual({ ...EN }, expected());
});

test('the Dutch catalogue covers every key, translated or declared the same as English', () => {
    const covered = new Set([...Object.keys(NL.translations), ...NL.sameAsEnglish]);
    assert.deepEqual([...covered].sort(), Object.keys(EN).sort());
    for (const [key, text] of Object.entries(NL.translations)) assert.notEqual(text, EN[key], `${key} is the English text`);
});
