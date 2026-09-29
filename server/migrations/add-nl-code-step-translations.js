#!/usr/bin/env node
/**
 * Dutch for the code step (2026-09-29): the parameters form, the automatic
 * checks and their rules, the large editor with the AI assistant and "Try
 * it", and the server's own sentences (a missing parameter, the assistant's
 * errors and edit summaries). Every key of the `code_step` namespace.
 *
 * The Dutch itself is in data/code-step-nl.json. SAME_AS_ENGLISH lists the
 * keys whose Dutch is the English text itself (Code, Log, Parameters); they
 * are not seeded, so a later rewording of the English is never hidden.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-code-step-translations.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'code-step-nl.json'));

/**
 * sha256 of data/code-step-nl.json. The boot ledger re-runs a migration when
 * THIS FILE's checksum changes and knows nothing about the data file, so the
 * data's hash is pinned here: every data change is a change to this file (the
 * test fails until it is updated).
 */
const DATA_SHA256 = '5c52586d4e6fab9c112bab6bff9e3d57e456583592fb71693fe4b799665d13d8';

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
        console.log(`[Migration] add-nl-code-step-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256 };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
