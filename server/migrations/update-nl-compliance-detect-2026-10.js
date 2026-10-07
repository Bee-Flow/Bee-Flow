#!/usr/bin/env node
/**
 * Dutch for the Compliance Center's round 2 detection and legal-wording fixes
 * (Oct 2026): the DSR clock is one calendar month (GDPR Art. 12(3)), not 30
 * days; the CRA notification and final report are separate deadlines; DORA,
 * Data Act, EAA, PLD, Machinery and AI Act texts follow the law's own terms
 * ("applies", not "in force"; deployer duties; Art. 30(5) formats); the
 * encryption-at-rest check names the real encryption levels; two new
 * calendar milestones (the GDPR procedural regulation, EN 301 549 V4.1.1).
 *
 * The Dutch is in data/compliance-detect-2026-10-nl.json:
 *   translations  keys that never had shipped Dutch, added when a workspace
 *                 does not have them yet. They include the title (and, where
 *                 its English did not change, the fix) of each check whose
 *                 description got Dutch here, so no check row is half English;
 *   reworded      Dutch that was shipped earlier and is now wrong or out of
 *                 step with the English. `was` is the earlier shipped text, or
 *                 a list when more than one version shipped (the pre-rename
 *                 "routines" wording, the text before the 6 Oct 2026 legal
 *                 review). It is replaced only while the workspace still has
 *                 exactly one of those texts, so a workspace's own wording is
 *                 never overwritten.
 *
 * add-nl-compliance-center-translations only ever ADDS missing keys, and the
 * boot ledger re-runs it only when its own source changes (not its data), so
 * without this file an existing install would keep "de 30-dagenklok loopt".
 * Runs after update-nl-legal-register-2026-10, whose new Dutch some of these
 * keys replace. Auto-runs from server boot (boot/bootMigrations.js). Manual:
 *   node server/migrations/update-nl-compliance-detect-2026-10.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'compliance-detect-2026-10-nl.json'));

/**
 * sha256 of data/compliance-detect-2026-10-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so the data's hash is pinned here (the test fails until it is updated).
 */
const DATA_SHA256 = '39658b369f0c08f1b60ce018b4000e5b2d8daf8151a088bb2d1bb6542f3f0aad';

const NL_TRANSLATIONS = Object.freeze({ ...DATA.translations });
const NL_REWORDED = Object.freeze(Object.fromEntries(
    Object.entries(DATA.reworded).map(([key, { was, now }]) => [key, Object.freeze({ was: Object.freeze([].concat(was)), now })]),
));

/** The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once. */
function applyNl(merged) {
    let added = 0;
    let reworded = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        // Missing → add the current text; still one of the old shipped texts
        // → replace; anything else is the workspace's own wording and stays.
        if (!merged[key] || was.includes(merged[key])) {
            merged[key] = now;
            reworded++;
        }
    }
    return { merged, added, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    let reworded = 0;
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current);
        added = result.added;
        reworded = result.reworded;
        return result.merged;
    });
    if (added > 0 || reworded > 0) {
        console.log(`[Migration] update-nl-compliance-detect-2026-10 applied (+${added} keys, ${reworded} reworded)`);
    }
    return { added, reworded };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, NL_REWORDED, DATA_SHA256 };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
