#!/usr/bin/env node
/**
 * One-time migration: Dutch for the import panel inside the App Studio
 * "New app" modal (2026-09), where a person brings a `.apptemplate` or
 * `.app` file from another Bee Flow instead of starting from the gallery,
 * plus the template gallery's own Export action next to it.
 *
 * Idempotent: only fills keys that are missing, so a workspace that already
 * curated its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-app-archive-import-translations.js
 */

const NL_TRANSLATIONS = {
    'app_studio.list.export_title': 'Dit sjabloon downloaden als bestand',
    'app_studio.list.export': 'Exporteren',
    'app_studio.list.import_intro': 'Breng een bestand mee uit een andere Bee Flow. Een sjabloon komt in de galerij van je organisatie terecht om apps van te maken; een app-archief komt binnen als werkende app, met zijn rijen en documenten er al in.',
    'app_studio.list.import_choose_file': 'Bestand kiezen',
    'app_studio.list.import_screen_one': '1 scherm',
    'app_studio.list.import_screen_many': '{n} schermen',
    'app_studio.list.import_choose_another': 'Ander bestand kiezen',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-app-archive-import-translations: added ${added} NL keys`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(({ added }) => {
        console.log(`Done (${added} added).`);
        process.exit(0);
    }).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
