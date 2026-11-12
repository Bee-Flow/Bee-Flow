#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for round 4a of the admin dashboard in the Studio layout (2026-11):
 * the Agent Designer's section bodies, the Support views behind the switch
 * and the Subscriptions tables. Data in data/admin-studio-4a-2026-11-nl.json.
 * SAME_AS_ENGLISH lists keys whose Dutch is the English text itself; they are
 * not seeded.
 *
 * Idempotent: only fills missing keys. Auto-runs from server boot
 * (boot/bootMigrations.js).
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'admin-studio-4a-2026-11-nl.json'));

/**
 * sha256 of data/admin-studio-4a-2026-11-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so the data's hash is pinned here; the test fails until it is updated.
 */
const DATA_SHA256 = '68fdb4b59aba42b8ea2a360380123e5c9856e60dc368a1c713fc417ec08da196';

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
        console.log(`[Migration] add-nl-admin-studio-4a-2026-11-translations applied (+${added} keys)`);
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
