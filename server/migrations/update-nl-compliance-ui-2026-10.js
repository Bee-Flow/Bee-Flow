#!/usr/bin/env node
/**
 * Dutch for the Compliance Center UI, round 2 (Oct 2026): the strings the
 * eleven UI packages added (rail, header, check expansion, requests and
 * incidents, Settings, overview, ISO registers, ROPA/DPIA, framework pages),
 * plus three keys whose English meaning changed in that round.
 *
 * The Dutch is in data/compliance-ui-2026-10-nl.json:
 *   translations  keys this round added, or that got Dutch for the first
 *                 time in it; added when a workspace does not have them yet.
 *   reworded      Dutch that shipped earlier for an English text that has
 *                 since changed meaning ("30 dagen · 72 uur · 24 uur — één
 *                 klok" became a hint about legal response deadlines, "Audits &
 *                 directiebeoordeling" became "Audits & beoordelingen", the
 *                 project retention label became a plain field name). It is
 *                 replaced only while the workspace still has the old shipped
 *                 text, so a workspace's own wording is never overwritten.
 *
 * WHY A SEPARATE FILE. add-nl-compliance-center-translations reads its map
 * from data/compliance-center-nl.json, but the boot ledger re-runs a migration
 * only when the MIGRATION FILE's checksum changes. That file has not changed
 * since it shipped, so a regenerated map reaches fresh installs only; an
 * existing install gets the new Dutch from here. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual:
 *   node server/migrations/update-nl-compliance-ui-2026-10.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'compliance-ui-2026-10-nl.json'));

/**
 * sha256 of data/compliance-ui-2026-10-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so the data's hash is pinned here (the test fails until it is updated).
 */
const DATA_SHA256 = '2fba75a6560cf10f6369097a0f0dbe7a7c8978f501626fbd959758857301f632';

const NL_TRANSLATIONS = Object.freeze({ ...DATA.translations });
const NL_REWORDED = Object.freeze({ ...DATA.reworded });

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
        // Missing → write the current text; present and still the old shipped
        // text → replace; anything else is the workspace's own wording and stays.
        if (!merged[key] || merged[key] === was) {
            if (merged[key] !== now) reworded++;
            merged[key] = now;
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
        console.log(`[Migration] update-nl-compliance-ui-2026-10 applied (+${added} keys, ${reworded} reworded)`);
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
