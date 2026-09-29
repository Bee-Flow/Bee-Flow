#!/usr/bin/env node
/**
 * Migration: Dutch translations for the Google Meet integrations strings
 * (Meeting Notes Google Meet support, 2026-07).
 *
 * Idempotent — only inserts keys that don't already have a NL value.
 *
 * Manual usage (NOT part of npm run db:migrate):
 *   node server/migrations/add-nl-gmeet-integrations-translations.js
 */

const NL_TRANSLATIONS = {
    'integ.google_meet_scope_missing': 'Meeting Notes kan je Google Meet-opnames importeren — autoriseer Google opnieuw om de extra rechten te verlenen.',
    'integ.google_reauthorize': 'Google opnieuw autoriseren',
    'integ.google_update_needed': 'Update nodig',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-gmeet-integrations-translations applied (+${added} keys)`);
    }
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
