#!/usr/bin/env node
/**
 * Dutch for the "Clear All" dialog of the memory panel (2026-09-23), which
 * now says WHOSE memory is about to go.
 *
 * The panel has two homes: Settings (your personal memory) and a project's
 * Memory tab (the project's shared pool). Its "Clear All" used to clear the
 * personal memory from both, under one dialog, "Delete all memories?", that
 * named neither. The project tab now clears the project's pool, and the
 * dialog and the error line say which of the two it is, and that the other
 * one stays.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-memory-clear-translations.js
 */

const NL_TRANSLATIONS = {
    'settings.memory_clear_personal_title': 'Al je persoonlijke herinneringen verwijderen?',
    'settings.memory_clear_personal_desc': 'Elke persoonlijke herinnering wordt verwijderd en niet meer in je chats gebruikt. Projectherinneringen blijven staan. Dit kan niet ongedaan worden gemaakt.',
    'settings.memory_clear_project_title': 'Alle herinneringen van dit project verwijderen?',
    'settings.memory_clear_project_desc': 'Elke herinnering in dit project wordt voor alle leden verwijderd en niet meer in de chats van het project gebruikt. Je persoonlijke herinneringen blijven staan. Dit kan niet ongedaan worden gemaakt.',
    'settings.memory_clear_confirm': 'Alles verwijderen',
    'settings.memory_clear_personal_error': 'Je persoonlijke herinneringen konden niet worden verwijderd. Probeer het opnieuw.',
    'settings.memory_clear_project_error': 'De herinneringen van dit project konden niet worden verwijderd. Probeer het opnieuw.',
    'settings.memory_clear_all': 'Alle persoonlijke herinneringen verwijderen',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-memory-clear-translations: added ${added} NL keys`);
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
