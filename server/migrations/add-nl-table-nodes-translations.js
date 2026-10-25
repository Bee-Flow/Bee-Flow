#!/usr/bin/env node
// @typecheck noImplicitAny
/**
 * Migration: Dutch names for the two table steps in the node catalog
 * (automations.node.read_table.* and automations.node.table.*).
 *
 * "Read table" is "Tabel inlezen", "Edit table" is "Tabel bewerken".
 *
 * Idempotent: only inserts keys that do not have a NL value yet. Runs at boot
 * from boot/bootMigrations.js (NL_TRANSLATIONS).
 *
 * Manual usage:
 *   node server/migrations/add-nl-table-nodes-translations.js
 */

const NL_TRANSLATIONS = {
    'automations.node.read_table.typeLabel': 'Tabel inlezen',
    'automations.node.table.typeLabel': 'Tabel bewerken',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-table-nodes-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
