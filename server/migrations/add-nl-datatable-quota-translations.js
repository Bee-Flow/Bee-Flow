#!/usr/bin/env node
// @typecheck
/**
 * Dutch for the refusals of the datatable storage envelope
 * (core/dataEngine/datatableLimits, datatables.quota_*): each says which limit
 * was reached and what to do about it, and the server sends it in the
 * reader's language.
 *
 * Idempotent: only fills keys that are missing. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-datatable-quota-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    'datatables.quota_bytes': 'De datatabellen hier hebben hun opslaglimiet van {limitMb} MB bereikt. Verwijder rijen of tabellen die je niet meer nodig hebt, of vraag je beheerder de limiet te verhogen.',
    'datatables.quota_rows_scope': 'De datatabellen hier bevatten al {used} rijen, het maximum is {limit}. Verwijder rijen of tabellen die je niet meer nodig hebt, of vraag je beheerder de limiet te verhogen.',
    'datatables.quota_rows_table': 'De datatabel "{name}" is vol ({limit} rijen). Verwijder rijen die je niet meer nodig hebt, of vraag je beheerder de limiet te verhogen.',
    'datatables.quota_sheet_tabs': 'Je hebt al {used} spreadsheettabbladen, het maximum is {limit}. Verwijder tabbladen die je niet meer nodig hebt uit je spreadsheets, of vraag je beheerder de limiet te verhogen.',
    'datatables.quota_tables_org': 'Deze organisatie heeft al {used} datatabellen, het maximum is {limit}. Verwijder tabellen die je niet meer nodig hebt onder Studio → Datatabellen, of vraag je beheerder de limiet te verhogen.',
    'datatables.quota_tables_user': 'Je hebt al {used} persoonlijke datatabellen, het maximum is {limit}. Verwijder tabellen die je niet meer nodig hebt onder Studio → Datatabellen, of vraag je beheerder de limiet te verhogen.',
});

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
function applyNl(merged) {
    let added = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    return { merged, added };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-datatable-quota-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
