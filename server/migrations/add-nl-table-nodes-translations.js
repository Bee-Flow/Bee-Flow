#!/usr/bin/env node
// @typecheck strict
/**
 * Migration: Dutch names for the table steps in the node catalog
 * (automations.node.read_table.*, automations.node.table.* and
 * automations.node.write_table.*).
 *
 * "Read table" is "Tabel inlezen", "Edit table" is "Tabel bewerken",
 * "Write table" is "Tabel wegschrijven".
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
    'automations.node.write_table.typeLabel': 'Tabel wegschrijven',
    'automations.node.write_table.defaultLabel': 'Tabel wegschrijven',
    'automations.node.write_table.label': 'Tabel wegschrijven',
    'automations.node.write_table.desc': 'Een tabel opslaan als Excel- of CSV-bestand, om te mailen, te uploaden of te downloaden.',
    'automations.node.write_table.help': 'Schrijft een tabel van een eerdere stap naar een Excel- of CSV-bestand: de kolommen die je kiest, in jouw volgorde, met de rijen om te controleren gemarkeerd. Een volgende stap kan het bestand mailen, uploaden of als download aanbieden.',
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
