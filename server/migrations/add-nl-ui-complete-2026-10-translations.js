#!/usr/bin/env node
/**
 * Dutch for every UI string that had none (2026-10).
 *
 * Every English UI string under server/i18n/defaults/en that no Dutch catalogue covered yet: about 9,400
 * keys across ~100 namespaces (agent studio, knowledge, skills, meetings, webpages, cowork, encryption,
 * apps, admin, chat, settings, ...). Before this, roughly two thirds of the interface fell back to English
 * for a Dutch reader.
 *
 * Terminology follows .claude/handoff/i18n-nl/GLOSSARY.md ("je", sentence case, fixed product terms);
 * a multi-word label reads the same everywhere it appears.
 *
 * The Dutch itself is in data/ui-complete-2026-10-nl.json: `translations` is seeded, `sameAsEnglish` lists the keys
 * whose Dutch is the English text itself (names, acronyms, codes); those are not seeded, the English default
 * already reads right.
 *
 * Only keys no other catalogue seeds, so boot order never decides the wording. Idempotent: only fills keys
 * that are missing, so a workspace that curated its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-ui-complete-2026-10-translations.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'ui-complete-2026-10-nl.json'));

/**
 * sha256 of data/ui-complete-2026-10-nl.json. The boot ledger re-runs a migration when THIS FILE's checksum changes and
 * knows nothing about the data file; pinning the data's hash here makes every data change a change to this
 * file. The test fails until it is updated.
 */
const DATA_SHA256 = '04c3d67ecfeaeef926ad4e6b965d919bca6eb973aeecde55eb633735cbbe53dd';

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
        console.log(`[Migration] add-nl-ui-complete-2026-10-translations applied (+${added} keys)`);
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
