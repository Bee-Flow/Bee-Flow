#!/usr/bin/env node
/**
 * Dutch for the legal register review of 6 Oct 2026: the Compliance Center's
 * framework descriptions, calendar milestones and check texts corrected
 * against the current law (AI Act as amended by Regulation (EU) 2026/1744,
 * CRA and NIS2 reporting clocks, Data Act switching duties, EAA scope), the
 * new milestones, and the "Legal status checked" chip and Sources block.
 *
 * The Dutch is in data/legal-register-2026-10-nl.json:
 *   translations  new keys, added when a workspace does not have them yet;
 *   reworded      Dutch that was shipped earlier and is now legally wrong or
 *                 incomplete. It is replaced only while the workspace still
 *                 has the old shipped text, so a workspace's own wording is
 *                 never overwritten.
 *
 * add-nl-compliance-center-translations only ever ADDS missing keys, so
 * without this file an existing install would keep the old Dutch (for
 * example "boetes tot € 35 mln / 7 %" on the Art. 50 milestone, which is the
 * Art. 5 tier). Auto-runs from server boot (boot/bootMigrations.js). Manual:
 *   node server/migrations/update-nl-legal-register-2026-10.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'legal-register-2026-10-nl.json'));

/**
 * sha256 of data/legal-register-2026-10-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so the data's hash is pinned here (the test fails until it is updated).
 */
const DATA_SHA256 = '11d607c1ffcb699fd95b9c099b60f14fa7bfe12a5355f2653a04d67d3e7c29d7';

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
        // Missing → the seed migration adds the current text; present and
        // still the old shipped text → replace; anything else is the
        // workspace's own wording and stays.
        if (!merged[key] || merged[key] === was) {
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
        console.log(`[Migration] update-nl-legal-register-2026-10 applied (+${added} keys, ${reworded} reworded)`);
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
