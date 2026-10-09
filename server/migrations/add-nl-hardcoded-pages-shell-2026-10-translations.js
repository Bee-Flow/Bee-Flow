#!/usr/bin/env node
/**
 * Dutch for the user-facing text that agent-hub used to hard-code in English
 * (2026-10): the pages, the app shell, chat, meetings, renderers and the other
 * shared components. The sentence under the chat composer ("Bee Flow runs on
 * your own server. AI can make mistakes...") is in here: its two keys were
 * never in the dictionary, so a Dutch user always saw the English default.
 *
 * The Dutch itself is in data/hardcoded-pages-shell-2026-10-nl.json.
 *
 * SAME_AS_ENGLISH lists the keys whose Dutch is the English text itself.
 * They are not seeded: the English default already reads right.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot (boot/bootMigrations.js).
 * Manual usage:
 *   node server/migrations/add-nl-hardcoded-pages-shell-2026-10-translations.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'hardcoded-pages-shell-2026-10-nl.json'));

/**
 * sha256 of data/hardcoded-pages-shell-2026-10-nl.json. The boot ledger re-runs a migration when THIS FILE's
 * checksum changes and knows nothing about the data file, so pinning the hash
 * here makes every data change a change to this file; the test fails until it
 * is updated.
 */
const DATA_SHA256 = '18f56e1c2d8693e1c61c754ca12dc86541a59198a5f6e1159f9a37739a92a9be';

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
        console.log(`[Migration] add-nl-hardcoded-pages-shell-2026-10-translations applied (+${added} keys)`);
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
