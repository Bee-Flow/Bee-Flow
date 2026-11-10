#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the second round of the admin dashboard in the Studio layout
 * (2026-11): the Appearance panel's sections and the short names in the Look
 * editor's section list. Data in data/admin-studio-2-2026-11-nl.json.
 * SAME_AS_ENGLISH lists keys whose Dutch is the English text itself; they are
 * not seeded.
 *
 * Idempotent: only fills missing keys. Auto-runs from server boot
 * (boot/bootMigrations.js).
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'admin-studio-2-2026-11-nl.json'));

/**
 * sha256 of data/admin-studio-2-2026-11-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so the data's hash is pinned here; the test fails until it is updated.
 */
const DATA_SHA256 = '18a5d74ce2613106b6ace834ca56a3935c2e174c21cebbd55628fb3a140a35fb';

const NL_TRANSLATIONS = Object.freeze({ ...DATA.translations });

/** Keys whose Dutch is the English text itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([...DATA.sameAsEnglish]);

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
        console.log(`[Migration] add-nl-admin-studio-2-2026-11-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256 };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
