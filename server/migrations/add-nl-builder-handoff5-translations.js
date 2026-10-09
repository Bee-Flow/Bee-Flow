#!/usr/bin/env node
/**
 * Dutch for the automation builder, design handoff 5 (2026-09-28):
 * the header and its status pill, the ribbon, the Settings page and its
 * dialogs (start, app button, notifications, who can do what, the AI Act
 * check, advanced), the Runs tab, the Versions tab, the three-column step
 * drawer (Comes in · What this step does · Continues on), plain-language
 * step errors, and agents and skills in an AI step.
 *
 * The artboards for this round were drawn IN DUTCH, so where an artboard has
 * a word, that word is used here (the status pill, "make vN live", the roles,
 * the Runs sentences, the Versions notes). The test pins a few of them.
 *
 * The Dutch itself is in data/builder-handoff5-nl.json.
 *
 * The "Find repeating work" keys (routines.repeating.*) were seeded here
 * until that page was rebuilt (2026-10); they moved, with the same Dutch, to
 * add-nl-repeating-work-translations.
 *
 * SAME_AS_ENGLISH lists the keys whose Dutch is the English word itself
 * (Live, Runs, Talk, JSON, v{version}, ...). They are not seeded: the
 * English default already reads right, and a seeded copy would only hide a
 * later rewording of the English.
 *
 * One key, one owner: these keys are seeded here and nowhere else. Several
 * sit under prefixes that add-nl-builder-redesign-translations owns
 * (routines.card., routines.canvas., routines.ndv., routines.mapping.,
 * routines.ribbon., routines.kind.); its coverage test skips the keys listed
 * here, so boot order can never decide the wording.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-builder-handoff5-translations.js
 */

const path = require('node:path');

// The Dutch is data (about a thousand keys), so it lives next to the other
// migration data rather than in this file: `translations` is seeded,
// `sameAsEnglish` lists the keys whose Dutch is the English text itself.
const DATA = require(path.join(__dirname, 'data', 'builder-handoff5-nl.json'));

/**
 * sha256 of data/builder-handoff5-nl.json. The boot ledger (boot/bootMigrations.js)
 * re-runs a migration when THIS FILE's checksum changes, and knows nothing about
 * the data file, so a Dutch key added to the JSON alone would never reach an
 * install that already ran this migration. Pinning the data's hash here makes
 * every data change a change to this file; the test fails until it is updated.
 */
const DATA_SHA256 = 'c0ef5961406067f6a536c8a9a2b36b9f15c1f9ad823e9a6f785a275bc0d44c91';

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
        console.log(`[Migration] add-nl-builder-handoff5-translations applied (+${added} keys)`);
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
