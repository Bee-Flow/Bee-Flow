#!/usr/bin/env node
// @typecheck
/**
 * Dutch for the share image setting of the website editor (cms_share.*): the
 * Design settings of the generated share image (card style, honeycomb).
 *
 * The Dutch itself is in data/cms-share-image-nl.json. SAME_AS_ENGLISH lists keys
 * whose Dutch is the English word itself; they are not seeded.
 *
 * Idempotent: only fills keys that are missing. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-cms-share-image-translations.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'cms-share-image-nl.json'));

/**
 * sha256 of data/cms-share-image-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so pinning the hash here makes every data change a change to this file.
 */
const DATA_SHA256 = '3f077d9e90e7336e34689b66864bd2126c7b4564114a4b2d85ed37cfdb885516';

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
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-cms-share-image-translations applied (+${added} keys)`);
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
