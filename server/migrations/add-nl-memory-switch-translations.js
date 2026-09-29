#!/usr/bin/env node
/**
 * Dutch for Settings → Memory (2026-09-17): the master switch, the two lines
 * that say what on and off mean, the statistics error state and its retry,
 * and the seven memory-type labels the count breaks down into.
 *
 * The switch is the per-user "may this turn read/write memory" decision from
 * core/memory/memoryPolicy.js. Off does not delete anything — the copy says
 * so, because a person who flips it should know their memories stay put.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-memory-switch-translations.js
 */

const NL_TRANSLATIONS = {
    'settings.memory_switch': 'Geheugen gebruiken',
    'settings.memory_switch_on_desc': 'Feiten en voorkeuren uit je chats worden opgeslagen en in latere chats gebruikt.',
    'settings.memory_switch_off_desc': 'Geheugen staat uit: er wordt niets nieuws opgeslagen en je opgeslagen herinneringen worden niet in chats gebruikt. Ze blijven hier staan — je kunt ze nog steeds beheren, exporteren of importeren.',
    'settings.memory_switch_error': 'De geheugeninstelling kon niet worden gewijzigd. Probeer het opnieuw.',
    'settings.memory_stats_error': 'Je geheugenstatistieken konden niet worden geladen.',
    'settings.memory_stats_retry': 'Opnieuw proberen',
    'settings.memory_type_instruction': 'Instructies',
    'settings.memory_type_person': 'Personen',
    'settings.memory_type_project': 'Projecten',
    'settings.memory_type_preference': 'Voorkeuren',
    'settings.memory_type_fact': 'Feiten',
};

// The Dutch really is the English word.
const SAME_AS_ENGLISH = [
    'settings.memory_type_workflow', // "Workflows"
    'settings.memory_type_context',  // "Context"
];

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-memory-switch-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-memory-switch-translations failed:', e.message);
        process.exit(1);
    });
}
