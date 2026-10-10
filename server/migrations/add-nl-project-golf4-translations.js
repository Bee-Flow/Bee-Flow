#!/usr/bin/env node
/**
 * Dutch for the project chat composers (2026-10, golf 4): the accessible
 * names of the shared composer box in the team chat and in "start a conversation".
 *
 * Idempotent: only fills keys that are missing. ADD, NEVER RENAME. Auto-runs
 * from server boot (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-project-golf4-translations.js
 */

const NL_TRANSLATIONS = {
    'project_chat.composer_label': 'Bericht aan het team',
    'project_chat.new_composer_label': 'Nieuw gesprek',
};

const SAME_AS_ENGLISH = [];

async function up({ languageStore = require('../stores/languageStore') } = {}) {
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-project-golf4-translations: added ${added} NL keys`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(({ added }) => {
        console.log(`Done (${added} added).`);
        process.exit(0);
    }).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
