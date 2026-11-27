#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for setting up and testing Microsoft Teams meeting notes (namespace
 * teams_setup): the setup guide, the diagnostics checklist (check titles,
 * result sentences, what to do, who can fix it), the admin consent link, the
 * members overview, organisation-wide import, what a member needs and how a
 * meeting becomes a note. Data in data/teams-setup-2026-11-nl.json.
 * SAME_AS_ENGLISH lists keys whose Dutch is the English text itself; they are
 * not seeded.
 *
 * Idempotent: only fills keys that are missing. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-teams-setup-2026-11-translations.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'teams-setup-2026-11-nl.json'));

/**
 * sha256 of data/teams-setup-2026-11-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so the data's hash is pinned here; the test fails until it is updated.
 */
const DATA_SHA256 = 'e7b6e9adc83cecbe020ccddfb8cf422e3ba13252880e7644a5f126bb52d67f35';

const NL_TRANSLATIONS = Object.freeze({ ...DATA.translations });

/** Keys whose Dutch is the English (a product name): nothing to translate. */
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
        console.log(`[Migration] add-nl-teams-setup-2026-11-translations applied (+${added} keys)`);
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
