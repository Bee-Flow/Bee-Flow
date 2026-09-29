#!/usr/bin/env node
/**
 * Migration: Dutch translations for the organisation registration-source
 * labels — the "Registered via" line on the admin org cards.
 *
 * Idempotent — only inserts keys that don't already have a NL value, safe to
 * re-run. Auto-runs from server boot (server/index.js). Manual usage:
 *   node server/migrations/add-nl-org-registration-source.js
 */

const NL_TRANSLATIONS = {
    'admin.org_source_label': 'Geregistreerd via',
    'admin.org_source_direct': 'Directe registratie',
    'admin.org_source_admin': 'Aangemaakt door beheerder',
    'admin.org_source_nextcloud_connector': 'Nextcloud-connector',
    'admin.org_source_unknown': 'Onbekend',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-org-registration-source applied (+${added} keys)`);
    }
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
