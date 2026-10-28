#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the Nextcloud trigger switch "also react to events of colleagues"
 * (namespace nc_trigger_scope, server/i18n/defaults/en/nc_trigger_scope.js;
 * filter.includeColleagues, issue #191).
 *
 * One namespace, one owner: this catalogue. Idempotent: only fills keys that
 * are missing, so a workspace that curated its own wording keeps it. Auto-runs
 * from server boot (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-nc-trigger-scope-2026-10-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    'nc_trigger_scope.label': 'Collega’s',
    'nc_trigger_scope.include_colleagues': 'Ook reageren op gebeurtenissen van collega’s',
    'nc_trigger_scope.hint': 'Uit: alleen wat je zelf doet start deze automatisering. Aan: ook een bericht, kaart, rij, formulierinzending of bestandswijziging van een collega start haar, maar alleen als het gaat om een gesprek, bord, tabel, formulier of bestand dat je zelf in Nextcloud kunt zien.',
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
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-nc-trigger-scope-2026-10-translations applied (+${added} keys)`);
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
