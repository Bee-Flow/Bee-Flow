#!/usr/bin/env node
// @typecheck strict
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
const DATA_SHA256 = '74ed128d05f689fbce1f54402c314d7d12de337afbb7f997bb836bd1743314d4';

const NL_TRANSLATIONS = Object.freeze({ ...DATA.translations });

/** Keys whose Dutch is the English text itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([...DATA.sameAsEnglish]);

/**
 * Keys whose English was reworded: replaced only while a workspace still has
 * the Dutch that shipped before (`was`), so an admin's own wording stays. The
 * new Dutch is the one in the data file.
 * The "no access" step error names more causes than a folder that is not shared.
 * @type {Readonly<Record<string, { was: string }>>}
 */
const NL_REWORDED = Object.freeze({
    'automations.step_error.nextcloud_no_access.cause': {
        was: 'Het account dat deze stap gebruikt kan {folder} niet openen. Deel de map met dat account, of kies een account dat hem wel kan openen.',
    },
    'automations.step_error.nextcloud_no_access.cause_generic': {
        was: 'Het account dat deze stap gebruikt kan dit bestand of deze map niet openen. Deel het met dat account, of kies een account dat het wel kan openen.',
    },
});

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
function applyNl(merged) {
    let added = 0;
    let reworded = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    for (const [key, { was }] of Object.entries(NL_REWORDED)) {
        if (merged[key] === was && NL_TRANSLATIONS[key]) {
            merged[key] = NL_TRANSLATIONS[key];
            reworded++;
        }
    }
    return { merged, added, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    let reworded = 0;
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        added = result.added;
        reworded = result.reworded;
        return result.merged;
    });
    if (added > 0 || reworded > 0) {
        console.log(`[Migration] add-nl-builder-handoff5-translations applied (+${added} keys, ${reworded} reworded)`);
    }
    return { added, reworded };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, NL_REWORDED, SAME_AS_ENGLISH, DATA_SHA256 };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
