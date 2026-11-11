#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch from the per-namespace data files in server/i18n/defaults/nl/
 * (<namespace>.json, next to the English en/<namespace>.js). One catalogue for
 * all of them, so a new namespace's Dutch is a new data file and nothing else:
 * no migration file, no pinned hash, no boot ladder line.
 *
 * The boot ladder's checksum of this entry includes every data file
 * (boot/bootMigrations.js, i18n/defaults/nl sourceHash), so a database that
 * already ran it runs it again after a file is added or changed, and the new
 * keys arrive there too.
 *
 * Idempotent: only fills keys that are missing, like every add-nl-* catalogue.
 * Auto-runs from server boot (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-namespace-files.js
 */

const { loadNamespaceFiles } = require('../i18n/defaults/nl');

const LOADED = loadNamespaceFiles();

const NL_TRANSLATIONS = Object.freeze({ ...LOADED.translations });

/** Keys whose Dutch is the English text itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([...LOADED.sameAsEnglish]);

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
        console.log(`[Migration] add-nl-namespace-files applied (+${added} keys from ${LOADED.namespaces.length} namespace files)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
