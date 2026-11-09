#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for round 3b of the admin dashboard in the Studio layout (2026-11):
 * the AI Monitor and Website analytics chrome (the period control and the
 * labels the restyle added). Data in data/admin-studio-3b-2026-11-nl.json.
 * SAME_AS_ENGLISH lists keys whose Dutch is the English text itself; they are
 * not seeded.
 *
 * Idempotent: only fills missing keys. Auto-runs from server boot
 * (boot/bootMigrations.js).
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'admin-studio-3b-2026-11-nl.json'));

/**
 * sha256 of data/admin-studio-3b-2026-11-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so the data's hash is pinned here; the test fails until it is updated.
 */
const DATA_SHA256 = '0054525e8b7dd12dd4d03d8901d5523e0d3edcf58438e3439abf4498a531e8db';

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
        console.log(`[Migration] add-nl-admin-studio-3b-2026-11-translations applied (+${added} keys)`);
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
