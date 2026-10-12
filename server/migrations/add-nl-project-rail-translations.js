#!/usr/bin/env node
/**
 * Dutch for the project rail (2026-10): the project switcher in the rail head
 * (with the current project's name for screen readers), its "Recent projects"
 * heading and the search pill's placeholder.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-project-rail-translations.js
 */

const NL_TRANSLATIONS = {
    'project_home.rail.switch': 'Project wisselen',
    'project_home.rail.switch_named': 'Project wisselen, huidig: {name}',
    'project_home.rail.recent': 'Recente projecten',
    'project_home.rail.search': 'Zoek in dit project…',
};

/** Nothing here is identical to English. */
const SAME_AS_ENGLISH = [];

/** @param {{ languageStore?: { addMissingGUITranslations: Function } }} [deps]  the real store unless a test hands one in */
async function up({ languageStore = require('../stores/languageStore') } = {}) {
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-project-rail-translations: added ${added} NL keys`);
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
