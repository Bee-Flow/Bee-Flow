#!/usr/bin/env node
/**
 * Dutch for the admin screens that had hard-coded English (2026-10):
 * subscriptions, organisation, AI configuration, monitoring, languages,
 * security (SSO) and the shared model picker. Data in
 * data/hardcoded-admin-2026-10-nl.json. SAME_AS_ENGLISH lists keys whose
 * Dutch is the English text itself; they are not seeded.
 *
 * Idempotent: only fills missing keys. Auto-runs from server boot
 * (boot/bootMigrations.js).
 */

const path = require('node:path');

// The Dutch is data (about a thousand keys), so it lives next to the other
// migration data rather than in this file: `translations` is seeded,
// `sameAsEnglish` lists the keys whose Dutch is the English text itself.
const DATA = require(path.join(__dirname, 'data', 'hardcoded-admin-2026-10-nl.json'));

/**
 * sha256 of data/hardcoded-admin-2026-10-nl.json. The boot ledger (boot/bootMigrations.js)
 * re-runs a migration when THIS FILE's checksum changes, and knows nothing about
 * the data file, so a Dutch key added to the JSON alone would never reach an
 * install that already ran this migration. Pinning the data's hash here makes
 * every data change a change to this file; the test fails until it is updated.
 */
const DATA_SHA256 = '863c67afb06747b236fb6aefa0530fc421330dc3c9e82cfd087df51c23aa9181';

const NL_TRANSLATIONS = Object.freeze({ ...DATA.translations });

/** Keys whose Dutch is the English text itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([...DATA.sameAsEnglish]);

/** The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once. */
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
        console.log(`[Migration] add-nl-hardcoded-admin-2026-10-translations applied (+${added} keys)`);
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
