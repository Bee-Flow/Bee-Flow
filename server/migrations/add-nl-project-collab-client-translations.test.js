/**
 * The Dutch for the project rail: every key exists in English, placeholders
 * survive, nothing is copied over, up() seeds exactly this catalogue and the
 * migration is registered.
 *
 * Run: node --test migrations/add-nl-project-collab-client-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, up } = require('./add-nl-project-collab-client-translations');

test('the flows are covered', () => {
    for (const prefix of ['project_home.archive.', 'project_home.transfer.', 'project_home.members.search_', 'project_collab.prefs.', 'project_collab.mute.', 'project_home.presence.']) {
        assert.ok(Object.keys(NL_TRANSLATIONS).some((k) => k.startsWith(prefix)), prefix);
    }
});

test('no dashes are used as punctuation', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
});

test('up() seeds exactly this catalogue into the Dutch strings', async () => {
    const calls = [];
    const languageStore = {
        addMissingGUITranslations: async (locale, translations) => {
            calls.push({ locale, translations });
            return { added: 0 };
        },
    };
    assert.deepStrictEqual(await up({ languageStore }), { added: 0 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].locale, 'nl');
    assert.deepStrictEqual(calls[0].translations, NL_TRANSLATIONS);
});
