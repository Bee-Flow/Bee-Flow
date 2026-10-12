#!/usr/bin/env node
/**
 * Dutch for the Learning Center lesson content (2026-10).
 *
 * The lesson texts of every course except Foundations (which add-nl-learning-foundations-translations
 * seeds): slides, quiz choices, matching pairs, checklists and the video titles, about 7,800 keys. A
 * Dutch learner now reads the whole lesson in Dutch, and a button or screen a lesson quotes is named
 * exactly as the Dutch interface shows it.
 *
 * The Dutch itself is in data/learn-content-2026-10-nl.json: `translations` is seeded, `sameAsEnglish` lists the keys
 * whose Dutch is the English text itself (names, acronyms, codes); those are not seeded, the English default
 * already reads right.
 *
 * Only keys no other catalogue seeds, so boot order never decides the wording. Idempotent: only fills keys
 * that are missing, so a workspace that curated its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-learn-content-2026-10-translations.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'learn-content-2026-10-nl.json'));

/**
 * sha256 of data/learn-content-2026-10-nl.json. The boot ledger re-runs a migration when THIS FILE's checksum changes and
 * knows nothing about the data file; pinning the data's hash here makes every data change a change to this
 * file. The test fails until it is updated.
 */
const DATA_SHA256 = '0fd7ba44e37ec55f1eb1ed7f38aaa40ec167765e1bbafa0648d8f15f5f3f3204';

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
        console.log(`[Migration] add-nl-learn-content-2026-10-translations applied (+${added} keys)`);
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
