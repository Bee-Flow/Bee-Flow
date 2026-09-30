#!/usr/bin/env node
/**
 * One-time migration: Dutch translations for the Projects collaboration work —
 * the project list entry point, shared conversations, and the live feed.
 *
 * Auto-runs from server boot (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-projects-collab-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting any
 * translation that already exists.
 */

const NL_TRANSLATIONS = {
    // ── Zijbalk ────────────────────────────────────────────────
    'sidebar.all_projects': 'Alle projecten',

    // ── Gedeelde gesprekken ────────────────────────────────────
    'projects.share_thread': 'Delen met project',
    'projects.unshare_thread': 'Delen stoppen',
    'projects.shared_badge': 'Gedeeld met het project',
    'projects.shared_threads': 'Gedeelde gesprekken',
    // projects.no_shared_threads was retired with the old project detail page
    // (2026-09, see removed-keys.txt); no component reads it any more.
    // De encryptie-waarschuwing bij het delen. Bewust expliciet: op de
    // zero-knowledge-tier is dit een echte, opzettelijke verzwakking, en die
    // hoort te staan op het moment dat de gebruiker de keuze maakt.
    'projects.share_encryption_warning':
        'Gedeelde gesprekken worden versleuteld met een sleutel van de organisatie, zodat elk projectlid '
        + 'en achtergrondtaken ze kunnen lezen. Je privégesprekken blijven ongewijzigd.',
    'projects.share_owner_only': 'Alleen de eigenaar van een gesprek kan het delen.',

    // ── Beurten en aanwezigheid ────────────────────────────────
    'projects.turn_busy': '{name} stelt nu een vraag aan de AI — jouw bericht staat in de wachtrij.',
    'projects.someone_typing': '{name} is aan het typen…',

    // ── Projectbronnen ─────────────────────────────────────────
    'projects.resources': 'In dit project',
    'projects.notebooks': 'Notitieboeken',
    'projects.routines': 'Routines',
    'projects.apps': 'Apps',
    'projects.add_existing': 'Bestaande toevoegen',
    'projects.remove_from_project': 'Uit project halen',

    // ── Conflicten en rechten ──────────────────────────────────
    'projects.conflict':
        'Dit project is ondertussen door iemand anders gewijzigd. Herlaad om hun wijzigingen te zien — '
        + 'jouw invoer staat nog in het formulier.',
    // projects.viewer_readonly: retired with the old project detail page (2026-09).
    'projects.access_revoked': 'Je toegang tot dit project is ingetrokken.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-projects-collab-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-projects-collab-translations failed:', e.message);
        process.exit(1);
    });
}
