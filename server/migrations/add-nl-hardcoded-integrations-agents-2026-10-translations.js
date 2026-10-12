#!/usr/bin/env node
/**
 * Dutch for the user-facing literals that used to be hard-coded English in
 * agent-hub: integrations (Azure, search, transcription, email, source-control
 * sync, Nextcloud), Agent Designer / Agent Wizard / version history, appearance
 * (icons editor and look), support inbox and its settings, Knowledge panels,
 * and the Nextcloud and initial setup wizards (2026-10).
 *
 * The Dutch itself is in data/hardcoded-integrations-agents-2026-10-nl.json.
 *
 * SAME_AS_ENGLISH lists the keys whose Dutch is the English text itself
 * (model names, example values, ...). They are not seeded: the English default
 * already reads right, and a seeded copy would only hide a later rewording.
 *
 * One key, one owner: these keys are seeded here and nowhere else.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-hardcoded-integrations-agents-2026-10-translations.js
 */

const path = require('node:path');

// The Dutch is data, so it lives next to the other migration data: `translations`
// is seeded, `sameAsEnglish` lists the keys whose Dutch is the English text itself.
const DATA = require(path.join(__dirname, 'data', 'hardcoded-integrations-agents-2026-10-nl.json'));

/**
 * sha256 of data/hardcoded-integrations-agents-2026-10-nl.json. The boot ledger (boot/bootMigrations.js)
 * re-runs a migration when THIS FILE's checksum changes, and knows nothing about
 * the data file, so a Dutch key added to the JSON alone would never reach an
 * install that already ran this migration. Pinning the data's hash here makes
 * every data change a change to this file; the test fails until it is updated.
 */
const DATA_SHA256 = 'd2ed2e4e96b866da352e75d2538b064cba6acc3db4d778c3a942df55f25ca8a4';

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
        console.log(`[Migration] add-nl-hardcoded-integrations-agents-2026-10-translations applied (+${added} keys)`);
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
