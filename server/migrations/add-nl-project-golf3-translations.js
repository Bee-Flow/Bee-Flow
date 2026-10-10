#!/usr/bin/env node
/**
 * Dutch for the project workspace dialogs, undo and connection status (2026-10,
 * golf 3): the Undo toasts (task, message, document, notebook, meeting, knowledge
 * base, member), the unsaved-changes bar of the task dialog and the band that
 * says the live connection fell back to polling or stopped.
 *
 * Idempotent: only fills keys that are missing. ADD, NEVER RENAME. Auto-runs
 * from server boot (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-project-golf3-translations.js
 */

const NL_TRANSLATIONS = {
    'project_home.undo': 'Ongedaan maken',
    'project_home.task_deleted': 'Taak "{name}" verwijderd',
    'project_home.unsaved_changes': 'Niet-opgeslagen wijzigingen',
    'project_home.discard': 'Verwerpen',
    'project_home.removed_from_project': '"{name}" uit het project gehaald',
    'project_home.kb_unlinked': '"{name}" losgekoppeld van het project',
    'project_home.members.removed': '{name} uit het project verwijderd',
    'project_home.message_deleted': 'Bericht verwijderd',
    'project_home.connection.polling': 'Opnieuw verbinden… deze pagina ververst elke 15 s.',
    'project_home.connection.stopped': 'Live updates zijn gestopt. Wijzigingen van anderen verschijnen pas nadat je opnieuw verbindt.',
    'project_home.connection.reconnect': 'Opnieuw verbinden',
};

const SAME_AS_ENGLISH = [];

async function up({ languageStore = require('../stores/languageStore') } = {}) {
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-project-golf3-translations: added ${added} NL keys`);
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
